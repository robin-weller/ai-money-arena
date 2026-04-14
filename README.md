# ai-money-arena

Minimal, production-ready autonomous agent system for GitHub Actions.

It runs three worker agents (`agent-a`, `agent-b`, `agent-c`) plus one overseer. State lives in JSON files, workers make one Gemini-guided decision per run, and the overseer publishes static JSON for a website and sends Telegram summaries.

## What it does

- Runs worker agents every 2 hours on GitHub Actions
- Stores all state in versioned JSON files
- Calls Gemini via REST using `GEMINI_API_KEY`
- Sends Telegram summaries and blocked-task alerts
- Publishes static website-friendly JSON in `/public-data`

## Project structure

```text
scripts/
  gemini.js
  gemini.ts
  runOverseer.js
  runOverseer.ts
  runWorker.js
  runWorker.ts
  telegram.js
  telegram.ts

state/
  config.json
  leaderboard.json
  messages.json
  tasks.json
  agents/
    agent-a.json
    agent-b.json
    agent-c.json

logs/
public-data/
.github/workflows/
  run-agents.yml
  weekly-maintenance.yml
```

## Requirements

- Node.js 20 or newer
- A Gemini API key
- A Telegram bot token and chat ID

## Setup

1. Clone the repo.
2. Install nothing unless you want to add tooling later. This project uses native Node APIs.
3. Set environment variables locally:

```bash
export GEMINI_API_KEY="your-gemini-key"
export TELEGRAM_BOT_TOKEN="your-telegram-bot-token"
export TELEGRAM_CHAT_ID="your-chat-id"
```

## Run locally

Run one worker:

```bash
node scripts/runWorker.js agent-a
```

Run all workers manually:

```bash
node scripts/runWorker.js agent-a
node scripts/runWorker.js agent-b
node scripts/runWorker.js agent-c
```

Run the overseer:

```bash
node scripts/runOverseer.js
```

Outputs:

- Worker activity is written to `/logs`
- Shared state is updated under `/state`
- Website JSON is written to `/public-data`

## GitHub Secrets

Add these repository secrets in GitHub:

1. Open your repo on GitHub.
2. Go to `Settings` -> `Secrets and variables` -> `Actions`.
3. Create these secrets:
   - `GEMINI_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`

Do not commit keys into the repository. The workflows read them from the GitHub Actions environment.

## Deploy on GitHub Actions

1. Paste or push this repo to GitHub.
2. Add the three GitHub secrets above.
3. Push to your default branch.
4. GitHub Actions will run workers every 2 hours and then run the overseer.

The main workflow also commits updated JSON state back to the repo when there are changes.

## How the agents work

- Each worker loads its own agent JSON plus shared `messages.json` and `tasks.json`
- Gemini returns one structured JSON decision
- The worker updates agent state and appends logs
- If Gemini reports `blocked_waiting_for_human`, the worker appends a task
- The overseer computes the leaderboard and writes:
  - `/public-data/leaderboard.json`
  - `/public-data/latest-runs.json`
  - `/public-data/tasks.json`
- The overseer sends a Telegram summary with actions, revenue, profit, and blocked tasks

## Configuration

Shared configuration lives in [state/config.json](/Users/robinweller/projects/ai-money-arena/state/config.json).

You can safely edit:

- agent strategies
- prompt limits
- log retention settings
- Telegram behavior

## Notes

- The runtime files are `.js` so GitHub Actions can execute them directly with `node`
- Matching `.ts` files are included so the project stays TypeScript-friendly if you want to adopt a build step later
- No database, framework, or secret storage is used in code

## Weekly placeholder

A placeholder workflow exists at `.github/workflows/weekly-maintenance.yml`. It does not change system behavior today, but gives you a place to add weekly reporting or cleanup later.
