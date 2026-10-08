#!/usr/bin/env bash
# Usage: run-arm.sh a|b|c map|ui  — one bake-off arm session, logs to ~/bakeoff/logs/<arm>-<task>.*
set -euo pipefail
arm=$1; task=$2
case "$arm" in a) place=BakeoffA.rbxl; extra="following every practice in CLAUDE.md (start with the empty project and the 4 checks if they are not set up yet)";;
               b) place=BakeoffB.rbxl; extra="using blox as described in CLAUDE.md/AGENTS.md";;
               c) place=BakeoffC.rbxl; extra="using blox as described in CLAUDE.md/AGENTS.md";; *) exit 2;; esac
case "$task" in map) title="Task 1 (Farm Town map)";; ui) title="Task 2 (the ZA shop window)";; *) exit 2;; esac
mkdir -p ~/bakeoff/logs; cd ~/bakeoff/$arm
log=~/bakeoff/logs/$arm-$task
if [ "${3:-}" = resume ]; then
  sid=$(python3 -c "import json,sys
for l in open('$log.jsonl'):
    d=json.loads(l)
    if d.get('type')=='system' and d.get('subtype')=='init': print(d['session_id']); break")
  n=1; while [ -e $log.part$n.jsonl ]; do n=$((n+1)); done
  mv $log.jsonl $log.part$n.jsonl; cp $log.start $log.part$n.start; cp $log.end $log.part$n.end 2>/dev/null || true
  date +%s > $log.start
  claude -p "You were cut off by a usage limit. Continue the task from where you stopped; do not redo finished work." --resume "$sid" \
    --mcp-config ~/bakeoff/$arm/arm.mcp.json --strict-mcp-config --permission-mode bypassPermissions \
    --max-turns 500 --model claude-opus-5-5 --output-format stream-json --verbose > $log.jsonl 2> $log.err || true
  date +%s > $log.end
  exit 0
fi
date +%s > $log.start
claude -p "Read ~/bakeoff/tasks/common.md and ~/bakeoff/tasks/$task.md, then do $title in this project, $extra. Studio place: $place (already open). Work autonomously until it meets the quality bar; do not ask questions." \
  --mcp-config ~/bakeoff/$arm/arm.mcp.json --strict-mcp-config --permission-mode bypassPermissions \
  --max-turns 500 --model claude-opus-5-5 --output-format stream-json --verbose > $log.jsonl 2> $log.err || true
date +%s > $log.end
