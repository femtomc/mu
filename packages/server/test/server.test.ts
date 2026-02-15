import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { createServer } from "../src/server.js";
import { InMemoryJsonlStore } from "@femtomc/mu-core";
import { IssueStore } from "@femtomc/mu-issue";
import { ForumStore } from "@femtomc/mu-forum";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("mu-server", () => {
	let tempDir: string;
	let server: any;

	beforeEach(async () => {
		// Create a temporary directory for test data
		tempDir = await mkdtemp(join(tmpdir(), "mu-server-test-"));
		
		// Create .mu directory structure
		const muDir = join(tempDir, ".mu");
		await Bun.write(join(muDir, "issues.jsonl"), "");
		await Bun.write(join(muDir, "forum.jsonl"), "");
		await Bun.write(join(muDir, "events.jsonl"), "");
		
		// Create server instance
		server = createServer({ repoRoot: tempDir });
	});

	afterEach(async () => {
		// Clean up temp directory
		await rm(tempDir, { recursive: true, force: true });
	});

	test("health check endpoint", async () => {
		const response = await server.fetch(
			new Request("http://localhost/healthz")
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
	});

	test("status endpoint", async () => {
		const response = await server.fetch(
			new Request("http://localhost/api/status")
		);
		expect(response.status).toBe(200);
		const status = await response.json();
		expect(status).toEqual({
			repo_root: tempDir,
			open_count: 0,
			ready_count: 0
		});
	});

	describe("issues API", () => {
		test("create issue", async () => {
			const response = await server.fetch(
				new Request("http://localhost/api/issues", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						title: "Test issue",
						body: "Test body",
						tags: ["test"],
						priority: 2
					})
				})
			);
			
			expect(response.status).toBe(201);
			const issue = await response.json();
			expect(issue.title).toBe("Test issue");
			expect(issue.body).toBe("Test body");
			expect(issue.tags).toEqual(["test"]);
			expect(issue.priority).toBe(2);
			expect(issue.status).toBe("open");
			expect(issue.id).toMatch(/^mu-/);
		});

		test("list issues", async () => {
			// Create an issue first
			await server.fetch(
				new Request("http://localhost/api/issues", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "Test issue" })
				})
			);

			const response = await server.fetch(
				new Request("http://localhost/api/issues")
			);
			
			expect(response.status).toBe(200);
			const issues = await response.json();
			expect(issues).toHaveLength(1);
			expect(issues[0].title).toBe("Test issue");
		});

		test("get issue by id", async () => {
			// Create an issue first
			const createResponse = await server.fetch(
				new Request("http://localhost/api/issues", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "Test issue" })
				})
			);
			const created = await createResponse.json();

			const response = await server.fetch(
				new Request(`http://localhost/api/issues/${created.id}`)
			);
			
			expect(response.status).toBe(200);
			const issue = await response.json();
			expect(issue.id).toBe(created.id);
			expect(issue.title).toBe("Test issue");
		});

		test("update issue", async () => {
			// Create an issue first
			const createResponse = await server.fetch(
				new Request("http://localhost/api/issues", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "Test issue" })
				})
			);
			const created = await createResponse.json();

			const response = await server.fetch(
				new Request(`http://localhost/api/issues/${created.id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ 
						title: "Updated title",
						status: "in_progress"
					})
				})
			);
			
			expect(response.status).toBe(200);
			const issue = await response.json();
			expect(issue.title).toBe("Updated title");
			expect(issue.status).toBe("in_progress");
		});

		test("close issue", async () => {
			// Create an issue first
			const createResponse = await server.fetch(
				new Request("http://localhost/api/issues", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "Test issue" })
				})
			);
			const created = await createResponse.json();

			const response = await server.fetch(
				new Request(`http://localhost/api/issues/${created.id}/close`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ outcome: "success" })
				})
			);
			
			expect(response.status).toBe(200);
			const issue = await response.json();
			expect(issue.status).toBe("closed");
			expect(issue.outcome).toBe("success");
		});
		
		test("claim issue", async () => {
			// Create an issue first
			const createResponse = await server.fetch(
				new Request("http://localhost/api/issues", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "Test issue" })
				})
			);
			const created = await createResponse.json();

			const response = await server.fetch(
				new Request(`http://localhost/api/issues/${created.id}/claim`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({})
				})
			);
			
			expect(response.status).toBe(200);
			const issue = await response.json();
			expect(issue.status).toBe("in_progress");
		});
	});

	describe("forum API", () => {
		test("post message", async () => {
			const response = await server.fetch(
				new Request("http://localhost/api/forum/post", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						topic: "test:topic",
						body: "Test message",
						author: "tester"
					})
				})
			);
			
			expect(response.status).toBe(201);
			const message = await response.json();
			expect(message.topic).toBe("test:topic");
			expect(message.body).toBe("Test message");
			expect(message.author).toBe("tester");
		});

		test("read messages", async () => {
			// Post a message first
			await server.fetch(
				new Request("http://localhost/api/forum/post", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						topic: "test:topic",
						body: "Test message"
					})
				})
			);

			const response = await server.fetch(
				new Request("http://localhost/api/forum/read?topic=test:topic")
			);
			
			expect(response.status).toBe(200);
			const messages = await response.json();
			expect(messages).toHaveLength(1);
			expect(messages[0].topic).toBe("test:topic");
			expect(messages[0].body).toBe("Test message");
		});

		test("list topics", async () => {
			// Post messages to different topics
			await server.fetch(
				new Request("http://localhost/api/forum/post", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						topic: "test:topic1",
						body: "Message 1"
					})
				})
			);
			
			await server.fetch(
				new Request("http://localhost/api/forum/post", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						topic: "test:topic2",
						body: "Message 2"
					})
				})
			);

			const response = await server.fetch(
				new Request("http://localhost/api/forum/topics")
			);
			
			expect(response.status).toBe(200);
			const topics = await response.json();
			expect(topics).toHaveLength(2);
			expect(topics.map((t: any) => t.topic)).toContain("test:topic1");
			expect(topics.map((t: any) => t.topic)).toContain("test:topic2");
		});
	});
});