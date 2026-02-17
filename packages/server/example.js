// Example usage of mu-server

import { createServer } from "./dist/index.js";

// Create and start server
const server = createServer({ port: 3001 });

console.log("Starting mu-server example...");
const bunServer = Bun.serve(server);

console.log(`Server running at http://localhost:${bunServer.port}`);

// Example API calls
setTimeout(async () => {
	console.log("\nTesting API endpoints:");
	
	// Health check
	const health = await fetch(`http://localhost:${bunServer.port}/healthz`);
	console.log("Health check:", await health.text());
	
	// Status
	const status = await fetch(`http://localhost:${bunServer.port}/api/status`);
	console.log("Status:", await status.json());
	
	// Create issue
	const createIssue = await fetch(`http://localhost:${bunServer.port}/api/issues`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			title: "Example issue",
			body: "Created via API",
			tags: ["example", "api"]
		})
	});
	const issue = await createIssue.json();
	console.log("Created issue:", issue.id);
	
	// List issues
	const listIssues = await fetch(`http://localhost:${bunServer.port}/api/issues`);
	const issues = await listIssues.json();
	console.log("Total issues:", issues.length);
	
	// Post to forum
	const forumPost = await fetch(`http://localhost:${bunServer.port}/api/forum/post`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			topic: "example:topic",
			body: "Hello from mu-server!",
			author: "example-script"
		})
	});
	const message = await forumPost.json();
	console.log("Posted to forum:", message.topic);
	
	console.log("\nPress Ctrl+C to stop the server...");
}, 1000);