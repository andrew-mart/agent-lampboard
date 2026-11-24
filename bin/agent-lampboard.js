#!/usr/bin/env node
// @ts-check
// agent-lampboard — A browser workspace for Claude Code, Codex, Antigravity CLI, and shell terminals. Run with --help for options.
import { main } from '../cli/main.js';

process.exitCode = await main(process.argv.slice(2));
