"""Hermes Agent plugin entrypoint for qmd-auto-context."""

from .hermes_adapter.plugin import register

__all__ = ["register"]
