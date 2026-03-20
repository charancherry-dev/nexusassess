# NexusAssess — Enterprise Aptitude Platform

Full-stack Node.js + PostgreSQL aptitude test platform.
Real-time sync via Server-Sent Events (SSE).

## Project Structure

```
nexusassess/
├── server.js          ← Express server + all API routes
├── package.json       ← Dependencies
├── .gitignore
└── public/
    └── index.html     ← Complete frontend
```

## Features

- 315 MNC + TCS NQT questions across 5 topics
- Admin adds candidates → instantly visible on candidate's browser
- Admin saves config → instantly updates all connected browsers
- Candidate submits → admin results table updates in real-time
- Incidents (tab switch, blur) logged and broadcast to admin live
- Each candidate gets a unique random question set covering all 5 topics
- PostgreSQL stores all data permanently — no data loss on refresh

## Deploy on Railway

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/charancherry-dev/nexusassess.git
git push -u origin main
```

### Step 2 — Create Railway Project

1. Go to railway.app
2. Click "New Project"
3. Click "Deploy from GitHub repo"
4. Select your nexusassess repo
5. Railway auto-detects Node.js and deploys

### Step 3 — Add PostgreSQL

1. In your Railway project click "New"
2. Choose "Database" → "PostgreSQL"
3. Railway creates the database and automatically sets DATABASE_URL

### Step 4 — Get Your URL

1. Click your web service in Railway
2. Go to Settings → Networking
3. Click "Generate Domain"
4. Share the URL with candidates

### Step 5 — Updates

Any time you change files:
```bash
git add .
git commit -m "Update"
git push
```
Railway redeploys automatically.

## Admin Credentials

Password: `Chaitu@Aptitude`

## Local Development (without PostgreSQL)

```bash
npm install
node server.js
```

Open http://localhost:3000
