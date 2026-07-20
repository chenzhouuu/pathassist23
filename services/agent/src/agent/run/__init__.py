"""Execution subsystem (PathAgent v2, increment 5): the stateless tool-invocation seam."""

from .executor import ExecutionError, InvocationResult, execute_plan, invoke

__all__ = ["ExecutionError", "InvocationResult", "execute_plan", "invoke"]
