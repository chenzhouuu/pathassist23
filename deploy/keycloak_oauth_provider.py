# girder_oauth/providers/keycloak.py
# Custom Keycloak OIDC provider for Girder v5 girder_oauth plugin.
# Drop-in addition to /opt/girder/plugins/oauth/girder_oauth/providers/keycloak.py

import urllib.parse

import requests

from girder.api.rest import getApiUrl
from girder.exceptions import RestException, ValidationException
from girder.models.setting import Setting
from girder.utility import setting_utilities

from .base import ProviderBase


# Register Keycloak settings so Girder accepts them via PUT /system/setting
_KEYCLOAK_SETTINGS = {
    'oauth.keycloak_client_id',
    'oauth.keycloak_client_secret',
    'oauth.keycloak_base_url',
    'oauth.keycloak_realm',
}


@setting_utilities.default(_KEYCLOAK_SETTINGS)
def _defaultKeycloakSettings():
    return ''


@setting_utilities.validator(_KEYCLOAK_SETTINGS)
def _validateKeycloakSettings(doc):
    pass


class Keycloak(ProviderBase):
    """
    Keycloak OIDC provider for Girder v5.

    Required Girder settings (set via Admin → Plugins → OAuth or API):
      oauth.keycloak_client_id
      oauth.keycloak_client_secret
      oauth.keycloak_base_url   e.g. http://auth.pathassist.health
      oauth.keycloak_realm      e.g. pathassist
    """

    _AUTH_SCOPES = ['openid', 'email', 'profile']

    @staticmethod
    def _baseUrl():
        return (Setting().get('oauth.keycloak_base_url') or '').rstrip('/')

    @staticmethod
    def _realm():
        return Setting().get('oauth.keycloak_realm') or 'master'

    @staticmethod
    def _realmUrl():
        base = Keycloak._baseUrl()
        realm = Keycloak._realm()
        return f'{base}/realms/{realm}/protocol/openid-connect'

    def getClientIdSetting(self):
        return Setting().get('oauth.keycloak_client_id')

    def getClientSecretSetting(self):
        return Setting().get('oauth.keycloak_client_secret')

    @classmethod
    def getUrl(cls, state):
        clientId = Setting().get('oauth.keycloak_client_id')
        if not clientId:
            raise Exception('No Keycloak client ID setting is present.')
        if not cls._baseUrl():
            raise Exception('No Keycloak base URL setting is present.')

        redirectUri = '/'.join((getApiUrl(), 'oauth', 'keycloak', 'callback'))

        params = urllib.parse.urlencode({
            'response_type': 'code',
            'client_id': clientId,
            'redirect_uri': redirectUri,
            'state': state,
            'scope': ' '.join(cls._AUTH_SCOPES),
        })
        return f'{cls._realmUrl()}/auth?{params}'

    def getToken(self, code):
        clientId = self.getClientIdSetting()
        clientSecret = self.getClientSecretSetting()
        redirectUri = '/'.join((getApiUrl(), 'oauth', 'keycloak', 'callback'))

        if not clientId or not clientSecret:
            raise Exception('Keycloak client ID or secret is not configured.')

        token_url = f'{self._realmUrl()}/token'
        data = {
            'grant_type': 'authorization_code',
            'code': code,
            'redirect_uri': redirectUri,
            'client_id': clientId,
            'client_secret': clientSecret,
        }
        response = requests.post(token_url, data=data)
        if response.status_code != 200:
            msg = response.json().get('error_description', response.text)
            raise Exception(f'Keycloak token exchange failed: {msg}')

        return response.json()

    def getUser(self, token):
        userinfo_url = f'{self._realmUrl()}/userinfo'
        headers = {
            'Authorization': f'Bearer {token["access_token"]}',
            'Accept': 'application/json',
        }
        resp = requests.get(userinfo_url, headers=headers)
        if resp.status_code != 200:
            raise RestException('Failed to fetch user info from Keycloak.', code=502)

        info = resp.json()
        oauthId = info.get('sub')
        if not oauthId:
            raise RestException('Keycloak did not return a user ID (sub).', code=502)

        email = info.get('email')
        if not email:
            raise RestException('Keycloak user has no email address.', code=502)

        firstName = info.get('given_name', '')
        lastName = info.get('family_name', '')

        user = self._createOrReuseUser(oauthId, email, firstName, lastName)

        # Auto-assign Girder groups based on Keycloak group membership.
        # Keycloak sends groups claim via the group-membership mapper on the client.
        kc_groups = info.get('groups', [])
        if kc_groups:
            self._syncGirderGroups(user, kc_groups)

        return user

    @staticmethod
    def _syncGirderGroups(user, kc_groups):
        """Add user to Girder groups matching their Keycloak groups (idempotent)."""
        from girder.models.group import Group
        group_model = Group()
        for group_name in kc_groups:
            girder_group = group_model.findOne({'name': group_name})
            if girder_group is None:
                continue
            # Check membership via group's member list (Girder v5 has no hasUser)
            already_member = group_model.find({
                '_id': girder_group['_id'],
                'memberIds': user['_id'],
            }).count() > 0
            if not already_member:
                group_model.addUser(girder_group, user, level=0)  # READ member
