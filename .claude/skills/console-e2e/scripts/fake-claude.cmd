@echo off
rem Windows launcher for fake-claude.mjs: Console wraps only .cmd/.bat shims, so CLAUDE_BIN must point here on Windows.
node "%~dp0fake-claude.mjs" %*
