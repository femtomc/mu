---
name: writing
description: "Crafts clear, precise technical documentation. Use when writing or reviewing docs, PR descriptions, error messages, READMEs, API references, or any technical prose."
---

# writing

Use this skill when asked to write, edit, or review technical prose. This includes documentation, READMEs, PR descriptions, error messages, comments, API references, and commit messages.

## Contents

- [Core contract](#core-contract)
- [Writing workflows](#writing-workflows)
- [Common patterns by document type](#common-patterns-by-document-type)
- [Editing and review workflow](#editing-and-review-workflow)
- [Evaluation scenarios](#evaluation-scenarios)

## Core contract

1. **Audience first**
   - Identify the reader's baseline knowledge before writing.
   - Write for the busiest reader who needs this information.
   - Honor their time: front-load the essential information.

2. **Clarity over style**
   - One idea per sentence. Complex concepts deserve their own space.
   - Active voice: "The system returns an error" not "An error is returned by the system."
   - Precise terminology: use the same word for the same concept throughout.
   - Concrete over abstract: "200ms latency" beats "fast performance."

3. **Structure for scanability**
   - Headings should communicate the document structure without reading prose.
   - Lists for parallel items (bullets for unordered, numbers for sequences).
   - Code blocks and tables over prose descriptions.
   - Inverted pyramid: conclusion, supporting details, background.

4. **Actionability**
   - Imperative for procedures: "Run the migration" not "The migration should be run."
   - Explicit consequences: state what happens if the user does X.
   - Anticipate failure modes in troubleshooting sections.

5. **Accessibility**
   - Plain language: avoid Latin abbreviations, buzzwords, metaphor-heavy descriptions.
   - Sentence length: average 15-20 words. Vary rhythm but never confuse length with sophistication.
   - Context for jargon: define domain-specific terms on first use or link to definitions.

6. **Verify by reading aloud**
   - Awkward phrasing surfaces when spoken.
   - Test instructions by following them exactly as written.
   - Delete mercilessly: if a sentence doesn't inform or direct, cut it.

## Writing workflows

### A) Documentation from scratch

1. **Identify the audience and goal**
   - Who will read this? What do they know? What must they do after reading?

2. **Outline the structure**
   - Opening paragraph: what this document covers and why it matters.
   - Body: group related concepts, sequence procedures in order of execution.
   - Closing: next steps, related resources, or troubleshooting.

3. **Draft with constraints**
   - Maximum 25 words per sentence on average.
   - Active voice for all instructions.
   - Code examples for any behavior described.

4. **Review against the contract**
   - Scan test: can a reader grasp structure from headings alone?
   - Action test: can a reader execute procedures without asking questions?
   - Deletion pass: remove sentences that don't inform or direct.

### B) PR/commit description

1. **What changed** (imperative, present tense)
2. **Why it changed** (context, motivation)
3. **How to verify** (testing steps, expected outcomes)
4. **Breaking changes** (if any, with migration path)

Keep under 80 characters per line in the summary. Body wraps at 72 characters.

### C) Error messages

1. **State what happened** (not what didn't)
2. **Explain why** (the root cause, if known)
3. **Provide the fix** (concrete next step, not generic advice)
4. **Include identifiers** (error codes, relevant IDs, log locations)

Example:
```
Error: Connection refused to database 'prod-db' on port 5432.
Cause: The database service is not running or firewall blocks port 5432.
Fix: Start the service with 'sudo systemctl start postgresql' or verify firewall rules.
Log: See /var/log/postgresql/postgresql-14-main.log for details.
```

## Common patterns by document type

### README.md

Structure:
1. One-line description of what this is
2. Installation/usage (minimal working example)
3. Key features (bullet list)
4. Configuration/options
5. Contributing/troubleshooting links

### API documentation

Per endpoint:
- Purpose (one sentence)
- HTTP method and path
- Parameters (name, type, required, description)
- Request/response examples
- Error codes and meanings

### Inline code comments

- **Why**, not what: explain intent, not obvious behavior.
- Non-obvious side effects or assumptions.
- TODO/FIXME with issue references, not vague notes.
- Public APIs: docstrings with parameters, returns, raises.

### Configuration docs

- Default values explicitly stated.
- Units for all numeric values (ms, bytes, percent).
- Validation constraints (min/max, allowed values).
- Impact of changing the value (what breaks, what improves).

## Editing and review workflow

When reviewing existing prose:

1. **Structural audit**
   - Does the outline serve the reader's goal?
   - Are headings descriptive? Is sequencing logical?

2. **Sentence-level edits**
   - Convert passive to active voice.
   - Replace vague quantifiers ("some", "many") with specifics.
   - Break long sentences (\> 25 words) into two.

3. **Accuracy check**
   - Verify all code examples execute as written.
   - Confirm version numbers, paths, and URLs are current.
   - Check that error messages match actual output.

4. **Final polish**
   - Read aloud for awkward rhythm.
   - Consistent formatting (punctuation in lists, code fences with languages).
   - Spelling and grammar (but prioritize clarity over grammatical perfection).

## Evaluation scenarios

1. **Drafting documentation for a new feature**
   - Prompt: user asks for docs for a feature they've implemented.
   - Expected: skill identifies audience, structures around user goals not implementation details, includes working examples, and ends with verification steps.

2. **Reviewing a PR description**
   - Prompt: user shares a draft PR description for feedback.
   - Expected: skill checks for imperative summary line, clear what/why/how structure, and explicit breaking change notice if applicable.

3. **Improving error messages**
   - Prompt: user shares error handling code or current error text.
   - Expected: skill transforms vague messages into specific what/why/fix format with actionable next steps and relevant identifiers.

4. **Editing README for clarity**
   - Prompt: user asks for help with a project's README.
   - Expected: skill restructures for inverted pyramid, adds minimal working example, replaces feature paragraphs with scannable lists, and ensures installation steps are complete and ordered.

## Quality bar

- Every sentence earns its place: informs or directs.
- No sentence requires a second reading to understand.
- A reader can act on instructions without asking clarifying questions.
- Code examples execute without modification.
- A skim reader grasps the document's purpose and structure.