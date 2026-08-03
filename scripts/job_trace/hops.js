// hops.js — what each hop is, why it is that way, and where in the tree to read it.
//
// Split from trace.js because it is prose, not logic: this file is what the console is *for*, and
// it should be editable by someone who is correcting an explanation rather than a state machine.
//
// UI copy is Chinese by request. Identifiers, URLs, payloads and file paths stay verbatim — a
// translated symbol is a symbol you cannot grep for.
//
// Every `src` entry was checked against the tree on 2026-08-02. Line numbers drift; the symbol
// name next to each one is what actually finds it again.

export const HOPS = [
  {
    id: 'auth',
    num: '0',
    title: '登录，换一个 token',
    lead: '用户名密码 → Girder token。之后每一跳都靠它。',
    why:
      '整条链路只有一种身份，从头到尾都是你的。浏览器拿到的 token 随 <code>Girder-Token</code> '
      + '请求头进 gateway，gateway 把它塞进 Celery 任务的 kwargs，driver 再把它放进发给 cellvit 的'
      + '请求体里（<code>runner.service_payload</code>）。所以 GPU 服务回头读切片时，用的仍然是你的'
      + '权限，而不是某个服务账号 —— 这也是为什么 token 过期时，失败会出现在链路很深的地方。',
    src: [
      ['runner.service_payload', 'services/girder_pathassist/src/girder_pathassist/runner.py:34'],
    ],
  },
  {
    id: 'form',
    num: '1',
    title: '表单 → startNuclei()',
    lead: 'Analysis 面板的表单值加上你画的矩形，交给 nucleiApi。',
    why:
      '表单每变一次，面板都会用 <code>mode=plan</code> 打一发一模一样的请求，去问"这一发要花多少"'
      + '—— 于是这条函数<b>必须</b>透传 <code>mode</code>。它曾经没有，而 <code>POST /classify</code> '
      + '也压根没有这个查询参数：结果是每动一下模型下拉框就真的跑了一次分类，一次点击发 4 个请求、'
      + '排 3 个 job。参数被静默忽略，没有任何报错。',
    src: [
      ['NATIVE_TOOLS.nuclei', 'src/components/panels/analysis/nativeCatalog.js:182'],
      ['startNuclei', 'src/api/nucleiApi.js:49'],
      ['startClassify', 'src/api/nucleiApi.js:73'],
    ],
  },
  {
    id: 'post',
    num: '2',
    title: 'POST /slides/{item}/nuclei',
    lead: '一个 POST，body 里只有 bbox 和 seg_hash。',
    why:
      '<code>bbox</code> 是 level-0 的切片像素坐标，不是屏幕坐标 —— 画框时 OpenSeadragon 就已经换算'
      + '过了，这一段是精确的（真实鼠标拖拽实测最大偏差 1 px）。<br><br>'
      + '区域跑<b>不需要</b> <code>seg_hash</code>：矩形本身就是掩膜。只有整片跑才需要组织分割，'
      + '用来决定哪些 tile 值得上 GPU —— 这个条件写在依赖表里，就是 nuclei 那条 '
      + '<code>Need(..., when=_whole_slide)</code>。',
    src: [
      ['start_nuclei', 'services/agent/src/agent/gateway/routes.py:1280'],
      ['DEPENDS_ON', 'services/agent/src/agent/gateway/plan.py:71'],
    ],
  },
  {
    id: 'plan',
    num: '3',
    title: 'gateway 规划：这一发到底要跑什么',
    lead: '列出这张片已有什么 → 给每一步算地址 → 只留还没建好的。',
    why:
      '地址（<code>art_hash</code>）只由参数和父节点算出，不由输出字节算出，所以整条 DAG 在第一个 '
      + 'job 开跑之前就能全部命名。这正是 Celery chain 能成立的前提：没有任何结果需要从上一环流到'
      + '下一环，每一环都能以不可变签名提交。<br><br>'
      + '但对 nuclei / tissue / biomarker 这三种<b>会长大</b>的产物，"字节已存在"不等于"没事可做"'
      + '—— 它只说明这条产物覆盖了<i>某些</i>东西，没说覆盖了你刚才要的那块。把它们当成不可变索引'
      + '的那段时间里，第二个区域、以及任何一次"停止后再续算"，都是静默 no-op：接口回 '
      + '<code>ready</code>，一个 job 都不排，屏幕上的掩膜纹丝不动 —— 而面板自己的说明写着相反的话。'
      + '<br><br>所以下面这两个数组要分开读：<code>plan</code> 是这一发牵扯到的<b>全部</b>步骤，'
      + '每步带一个 <code>built</code>（字节在不在磁盘上）；<code>steps</code> 才是<b>真的要跑</b>的'
      + '那些。一个步骤可以同时 <code>built: true</code> 和出现在 <code>steps</code> 里 —— '
      + '那不是矛盾，那就是"会长大"的全部含义。',
    src: [
      ['GROWABLE_KINDS', 'services/agent/src/agent/gateway/plan.py:101'],
      ['missing', 'services/agent/src/agent/gateway/plan.py:189'],
      ['_plan_and_dispatch', 'services/agent/src/agent/gateway/routes.py:498'],
    ],
  },
  {
    id: 'dispatch',
    num: '4',
    title: 'gateway → Girder：POST /pathassist/chain',
    lead: '把待办步骤按顺序交给 Girder，换回 chain_id 和第一个 girder_job_id。',
    why:
      '这一跳<b>不写 artifact 行</b>。行的含义是"字节已经在磁盘上"，而此刻一个字节都没有。运行中'
      + '的这一段，这个 run 只活在 Girder job 上，Workspace 靠 <code>art_hash</code> 把它当作一条 '
      + 'ghost row 贴到已有的行上。<br><br>'
      + '好处很实在：一条链跑到一半停了，没有任何东西需要清理 —— 没跑的步骤什么都没留下，也没有'
      + '半条行需要有人去判断它算不算数。',
    src: [
      ['_plan_and_dispatch', 'services/agent/src/agent/gateway/routes.py:498'],
      ['PathAssistResource.runChain', 'services/girder_pathassist/src/girder_pathassist/rest.py:133'],
    ],
  },
  {
    id: 'queue',
    num: '5',
    title: 'Girder 建 Celery chain，发进 pathassist 队列',
    lead: '每一步做成不可变签名 .si，串成 chain 发布。',
    why:
      '用 <code>.si</code>（immutable signature）而不是 <code>.s</code>：chain 默认会把上一环的返回值'
      + '塞给下一环当第一个参数，这里不需要 —— 每一环的地址在第 3 跳就已经全部算好了。<br><br>'
      + 'kind 必须在插件的 <code>KINDS</code> 表里，否则 Girder 当场 400。这张表和路由表 '
      + '<code>ROUTES</code>、标题表 <code>TITLES</code> 是三张分开的表：<code>classify</code> 曾经'
      + '只加进了后两张，于是每一次分类派发都被 Girder 拒绝（400 → gateway 报 502），而磁盘上的代码'
      + '看起来完全正确。现在有一个测试专门把这三张表互相钉住。',
    src: [
      ['runChain', 'services/girder_pathassist/src/girder_pathassist/rest.py:133'],
      ['KINDS / TITLES', 'services/girder_pathassist/src/girder_pathassist/__init__.py'],
      ['ROUTES', 'services/girder_pathassist/src/girder_pathassist/routing.py:48'],
    ],
  },
  {
    id: 'job',
    num: '6',
    title: 'Celery worker 收到消息，job 进 RUNNING',
    lead: 'driver 把 Girder job 绑到这次运行上，然后开始驱动。',
    why:
      'driver 自己什么都不算、什么都不决定。它只做三件事：把服务的读数翻译成 <code>JobManager</code> '
      + '调用、把 Celery 的撤销标志递给 runner、让 job 落在正确的终态上。所有带分支的逻辑都在 '
      + '<code>runner.py</code> / <code>status.py</code> —— 那里不需要 broker、Mongo 或 GPU 就能测，'
      + '这也是这两个文件存在的全部理由。<br><br>'
      + '右边的进度条读数来自 <code>jm.updateProgress</code>：服务给得出真实计数就报计数'
      + '（<code>28 / 46 · classify</code>），给不出就报百分比。',
    src: [
      ['run_analysis', 'services/girder_pathassist/src/girder_pathassist/girder_worker_plugin/driver.py:41'],
    ],
  },
  {
    id: 'poll',
    num: '7',
    title: 'driver 提交给 cellvit，然后每秒问一次',
    lead: 'POST /nuclei 换回服务自己的 job_id，再每 1 秒 GET /nuclei/status/{job_id}。',
    logs: 'agent-celery-1',
    why:
      '<b>两个 job id，别搞混</b>：Girder job id 是 Runs 列表里那条给人看的记录，cellvit 的 job_id '
      + '是服务内部的。中间那张 <code>routing.ROUTES</code> 表就是让 driver 知道该拨哪个地址的。'
      + '<br><br>各服务的接口<b>并不统一</b>，而且没有被强行抹平：preprocess 的 body 键叫 '
      + '<code>item</code>，三个 JobQueue 服务叫 <code>slide_ref</code>；状态结果一个在顶层、一个'
      + '嵌在 <code>result</code> 下。发错键不是什么微妙的失败 —— 一次 nuclei 派发在一秒内就回了 '
      + '<code>400: slide_ref is required</code>。<br><br>'
      + '状态 404 当<b>失败</b>处理，而不是继续轮询：服务重启后从这里看就长这样，而"行卡在 running '
      + '永远不动、没人分得清是死了还是在算"正是这一版要消灭的缺陷。',
    src: [
      ['submit', 'services/girder_pathassist/src/girder_pathassist/runner.py:45'],
      ['read_status', 'services/girder_pathassist/src/girder_pathassist/runner.py:66'],
      ['ROUTES', 'services/girder_pathassist/src/girder_pathassist/routing.py:48'],
    ],
  },
  {
    id: 'gpu',
    num: '8',
    title: 'cellvit 逐个核心瓦片算',
    lead: '把你的矩形放大到 2048 的核心瓦片格，只算还没覆盖过的那些。',
    logs: 'agent-cellvit-1',
    why:
      '<b>这就是"我选的和跑出来的不一样"的原因，而且是设计如此。</b>存储的粒度是 2048 px 的核心'
      + '瓦片（外带 256 px halo 用来接边），所以一个矩形永远向外取整到它碰到的整块瓦片。左边那张图'
      + '把两者画在了一起：红框是你画的，蓝格是它实际算的。<br><br>'
      + '换来的是：同一张片的两次运行共享同一个地址，于是第二个区域<b>续算</b>在第一个之上而不是'
      + '重算，停掉的整片跑再点一次就从断点接着走。代价就是你看到的这个 —— 它算得比你画的多。',
    src: [
      ['POST /nuclei', 'services/cellvit/src/cellvit_service/routes.py:86'],
      ['POST /classify', 'services/cellvit/src/cellvit_service/routes.py:205'],
    ],
  },
  {
    id: 'report',
    num: '9',
    title: '回报结果 —— 到这一刻才写行',
    lead: 'report_terminal 把计数和覆盖回报给 gateway，gateway 写或更新 artifact 行。',
    logs: 'agent-copilot-1',
    why:
      '行 = "字节存在"的断言，所以直到现在才写。这也是为什么 classify <b>不会</b>产生第二行：它带的'
      + '是被它命名的那条 artifact 的<b>同一个</b> <code>art_hash</code>，回报落在已有的行上，'
      + '于是 Workspace 里是一条 Nuclei 行上多了一套命名。<br><br>'
      + '协作式停止不算失败：停下来的 run 留下的是可用的字节和一个可续算的状态，所以它落 '
      + '<code>CANCELED</code> 并带着自己的计数，和跑完的 run 一样带 —— 而不是落 '
      + '<code>ERROR</code> 把已经算出来的东西说成垃圾。',
    src: [
      ['report_terminal', 'services/girder_pathassist/src/girder_pathassist/runner.py:145'],
      ['report_artifact_result', 'services/agent/src/agent/gateway/routes.py:632'],
    ],
  },
  {
    id: 'render',
    num: '10',
    title: '前端合并，出图',
    lead: 'Runs feed 和 artifacts 按 art_hash union；OpenSeadragon 按 tile URL 拉 PNG。',
    why:
      '<code>joinRuns</code> 把 artifacts 和在跑的 job 按<b>地址</b>合并，所以一个地址永远只有一行，'
      + '不管上面压了几个 run。它曾经是"每个未完成的 run 生成一个 ghost"，于是同一个地址上的第二个 '
      + 'run 会复制出一行：React key 撞车、标题写着 Cell classification、而且比它自己的 run 活得还久。'
      + '<br><br>切换命名是<b>改 URL</b>（<code>?taxonomy=</code>），不是重算：同一批细胞的几套标签'
      + '都存在同一条 artifact 里，切换只是让瓦片按另一套颜色重画。',
    src: [
      ['joinRuns', 'src/components/workspace/runJoin.js:36'],
      ['tileUrl', 'src/api/nucleiApi.js:115'],
    ],
  },
];
