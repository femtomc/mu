# @femtomc/mu-server

HTTP JSON API server for mu issue and forum stores.

## Installation

```bash
bun add @femtomc/mu-server
```

## Usage

```typescript
import { createServer } from "@femtomc/mu-server";

// Create server with default options (uses current directory as repo root)
const server = createServer();

// Or specify custom repo root and port
const server = createServer({
  repoRoot: "/path/to/repo",
  port: 8080
});

// Start the server
Bun.serve(server);
```

## API Endpoints

### Health Check

- `GET /healthz` or `GET /health` - Returns 200 OK

### Status

- `GET /api/status` - Returns repository status
  ```json
  {
    "repo_root": "/path/to/repo",
    "open_count": 10,
    "ready_count": 3
  }
  ```

### Issues

- `GET /api/issues` - List issues
  - Query params: `?status=open&tag=bug`
- `GET /api/issues/:id` - Get issue by ID
- `POST /api/issues` - Create new issue
  ```json
  {
    "title": "Issue title",
    "body": "Issue description",
    "tags": ["bug", "priority"],
    "priority": 2,
    "execution_spec": { ... }
  }
  ```
- `PATCH /api/issues/:id` - Update issue
- `POST /api/issues/:id/close` - Close issue
  ```json
  {
    "outcome": "success"
  }
  ```
- `POST /api/issues/:id/claim` - Claim issue (changes status to in_progress)
- `GET /api/issues/ready` - Get ready issues
  - Query param: `?root=issue-id`

### Forum

- `GET /api/forum/topics` - List forum topics
  - Query param: `?prefix=issue:`
- `GET /api/forum/read` - Read messages from topic
  - Query params: `?topic=issue:123&limit=50`
- `POST /api/forum/post` - Post message to topic
  ```json
  {
    "topic": "issue:123",
    "body": "Message content",
    "author": "username"
  }
  ```

## Running the Server

### CLI

```bash
# Install globally
bun install -g @femtomc/mu-server

# Run server (looks for .mu/ in current directory or ancestors)
mu-server

# Or set custom port
PORT=8080 mu-server
```

### Programmatic

```bash
# Run the example
bun run example.js
```

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Build
bun run build

# Start server (after building)
bun run start
```

## Architecture

The server uses:
- Filesystem-backed JSONL stores (FsJsonlStore)
- IssueStore and ForumStore from mu packages
- Bun's built-in HTTP server
- Simple REST-style JSON API

All data is persisted to `.mu/` directory:
- `.mu/issues.jsonl` - Issue data
- `.mu/forum.jsonl` - Forum messages
- `.mu/events.jsonl` - Event log