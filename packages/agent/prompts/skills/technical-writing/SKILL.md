---
name: technical-writing
description: "Produces clear, argument-driven technical prose. Use when drafting or reviewing systems papers, design docs, READMEs, PR descriptions, error messages, API references, or other technical communication."
---

# technical writing

Use this skill when asked to write, edit, or review technical prose. This includes research/systems papers, design docs, RFCs, READMEs, PR descriptions, commit messages, error messages, API references, and postmortems.

This skill emphasizes argument quality (why the work matters, why choices are defensible, what evidence supports claims), not just sentence polish.

## Source foundations

This guidance synthesizes:

- Dan Cosley, *Writing more useful systems papers, maybe* (reader value + "why" over "what")
- Kayvon Fatahalian, *What Makes a (Graphics) Systems Paper Beautiful* (goals/constraints, organizing insight, design decisions, evaluation causality)
- Daniel Ritchie, *Three-phase Paper Writing* (phase-based drafting and feedback loops)
- Roy Levin and David Redell, *How (and How Not) to Write a Good Systems Paper* (originality/reality/lessons/choices/context/focus/presentation rubric)

## Contents

- [Core contract](#core-contract)
- [Core argument spine](#core-argument-spine)
- [Writing workflows](#writing-workflows)
- [Section checklists (papers and deep technical docs)](#section-checklists-papers-and-deep-technical-docs)
- [Common crash landings](#common-crash-landings)
- [Editing and review workflow](#editing-and-review-workflow)
- [Evaluation scenarios](#evaluation-scenarios)
- [Quality bar](#quality-bar)

## Core contract

1. **Reader value over author chronology**
   - Do not write "what I did" narratives.
   - Write for what the reader should understand, decide, or do after reading.

2. **Lead with why**
   - State why the problem matters before deep implementation detail.
   - Make stakes explicit: who benefits, what improves, what becomes possible.

3. **Define problem shape explicitly**
   - State goals, non-goals, constraints, and assumptions.
   - If these are unclear, the design cannot be evaluated fairly.

4. **Name the central insight**
   - State the organizing principle in plain language.
   - A system artifact is not the contribution by itself; the transferable insight is.

5. **Explain choices, not just outcomes**
   - Highlight key design decisions and why they were chosen.
   - Discuss meaningful alternatives and tradeoffs.
   - Separate core decisions from incidental implementation details.

6. **Attach evidence to claims**
   - For each major claim, provide concrete evidence.
   - Evaluate whether the proposed decisions caused the observed results.
   - Prefer claim-by-claim validation over a single undifferentiated benchmark dump.

7. **State lessons and limits**
   - Tell readers what generalizes and what does not.
   - Be explicit about assumptions and boundary conditions.

8. **Avoid revisionist history**
   - Do not present a magically linear path if work was iterative.
   - Briefly documenting failed paths and surprises increases credibility and usefulness.

9. **Write for scanability and precision**
   - Strong headings, short paragraphs, concrete nouns, consistent terminology.
   - Define terms before use; minimize forward references.

10. **Polish matters**
    - Clear grammar, correct spelling, and coherent figure captions are part of technical quality, not cosmetics.

## Core argument spine

Use this skeleton for most substantial technical writing:

1. **Problem and stakes**: What problem exists, and why should this reader care now?
2. **Gap**: Why current approaches are insufficient under real constraints.
3. **Insight**: The key idea / organizing observation.
4. **Approach**: What was built/proposed and the major decisions.
5. **Evidence**: What data, experiments, deployments, or analysis support each claim.
6. **Implications**: What new capability or practical outcome this enables.
7. **Limits**: Assumptions, non-goals, failure modes, and open questions.

If a section cannot map to this spine, it is often off-topic, under-motivated, or prematurely detailed.

## Writing workflows

### A) Systems/research paper workflow (phase-based)

#### Phase 0: contribution test (before full drafting)

- Can the central idea be stated in one short paragraph?
- Is the problem specific and meaningful?
- Is the contribution significant enough for the venue?
- Is related work understood deeply enough to establish novelty?
- Is the work implemented or otherwise justified at the level needed for credibility?

If these answers are weak, improve the work/story before expanding prose.

#### Phase I: section-level outline

Use a stable scaffold:

1. Introduction
2. Related Work / Context
3. Approach Overview
4. Method / Design sections
5. Results / Evaluation
6. Discussion / Limitations / Future Work

At outline time:
- List explicit contributions in the introduction.
- Name evaluation subsections early (for example: ablations, latency, usability, robustness).
- Capture known limitations as a running list.

#### Phase II: sentence-level skeleton

- Write one line per intended sentence.
- Focus on information content, not elegance.
- Ensure each section’s opening paragraph states what is in the section and why it matters.
- For every important design decision, add explicit justification and mention alternatives.
- Draft figure/table placeholders early so missing evidence is visible.

#### Phase III: polish and technical precision

- Convert skeleton text into clear prose.
- Tighten wording, remove repetition, standardize terminology.
- Upgrade captions so figures stand alone.
- Add citations and math formatting.
- Finalize abstract once argument and evidence are stable.

Note: drafting a short contribution summary early is useful; final abstract text should still be revised late.

#### Phase IV+: feedback loops

- Early feedback: argument, framing, contribution clarity.
- Late feedback: explanation gaps, ambiguity, wording, factual correctness.
- Iterate until reviewers can identify contributions and evidence without guessing.

### B) Design docs and RFCs

Recommended structure:

1. Problem context and impact
2. Goals, non-goals, and constraints
3. Proposed design and key decisions
4. Alternatives considered (and why rejected)
5. Validation plan and success metrics
6. Rollout/migration plan
7. Risks, failure modes, and mitigations
8. Open questions

Treat design docs as decision records, not implementation diaries.

### C) PR descriptions and commit messages

Use this order:
1. **What changed**
2. **Why this change was needed**
3. **How to verify** (exact commands/tests)
4. **Risk / rollout / breaking changes**

Keep summaries imperative and concrete.

### D) Error messages and user-facing diagnostics

Include:
1. What happened
2. Why (if known)
3. What the user can do next
4. Context IDs/paths/log pointers

Bad: "Operation failed"

Better:
```
Error: Could not load config from /etc/mu/config.json.
Cause: JSON parse error at line 48 (trailing comma).
Fix: Remove the trailing comma and re-run `mu control reload`.
Details: parser_error_code=EJSON_TRAILING_COMMA
```

## Section checklists (papers and deep technical docs)

### Introduction

- Does it clearly establish problem importance?
- Are constraints and context realistic?
- Are explicit contributions listed?
- Can a busy reader understand the paper’s value from this section alone?

### Related work / context

- Is comparison explicit (similarities and differences), not name-dropping?
- Are prior works treated respectfully and accurately?
- Does this section sharpen the novelty claim?

### Design / approach

- Are key decisions distinguished from implementation detail?
- Are alternatives and tradeoffs discussed?
- Are assumptions explicit?
- Is there a clear organizing principle?

### Evaluation

- Is each major claim tested directly?
- Do results explain *why* outcomes occurred, not only *that* they occurred?
- Are baselines/comparators fair and clearly described?
- Are limitations and threats to validity disclosed?

### Discussion / conclusion

- Are lessons explicit and transferable?
- Are boundaries and non-generalizable aspects named?
- Are future directions grounded in observed limits (not generic filler)?

## Common crash landings

- Leading with implementation detail before problem significance.
- "Summer vacation" narrative: chronology without transferable lessons.
- Listing features instead of defending decisions.
- Claiming novelty without explicit comparison to prior work.
- Hiding assumptions or omitting non-goals.
- Evaluating only aggregate outcomes while ignoring causal design claims.
- Presenting a cleaned-up fictional process (revisionist history).
- Related-work sections that only attack others or only list citations.
- Forward-reference overload and undefined terms.
- Sloppy grammar/formatting that signals weak rigor.

## Editing and review workflow

When reviewing existing prose:

1. **Structural pass**
   - Is the document organized around reader questions?
   - Are sections ordered by decision value (why -> what -> evidence -> implications)?

2. **Argument pass**
   - Highlight major claims.
   - Verify each claim has evidence and scope.
   - Flag assertions without backing.

3. **Design-decision pass**
   - Confirm key decisions are explicit.
   - Check whether alternatives and tradeoffs are discussed.

4. **Evidence pass**
   - Validate that evaluation supports claimed contributions.
   - Check reproducibility details (versions, commands, datasets, parameters).

5. **Language pass**
   - Convert vague phrases to measurable statements.
   - Remove redundancy and filler.
   - Ensure consistent terminology and active voice where useful.

6. **Final polish**
   - Verify figures/tables/captions stand on their own.
   - Fix grammar/spelling/format consistency.
   - Read key sections aloud for clarity.

## Evaluation scenarios

1. **Systems paper draft review**
   - Prompt: user asks why reviews say "interesting system, weak paper".
   - Expected: identify missing problem framing, unclear central insight, absent design-rationale discussion, or evaluation-claim mismatch.

2. **Design doc quality upgrade**
   - Prompt: user provides an implementation-heavy RFC.
   - Expected: restructure around goals/constraints, key decisions, alternatives, and validation plan.

3. **PR description improvement**
   - Prompt: user shares a vague PR summary.
   - Expected: rewrite into what/why/how-to-verify/risk with concrete commands.

4. **Diagnostic message rewrite**
   - Prompt: user shares generic errors.
   - Expected: produce actionable what/why/fix/details messages with identifiers and next steps.

## Quality bar

- Reader can state the problem, insight, and contribution after a quick skim.
- Major claims are backed by explicit evidence.
- Key decisions and tradeoffs are visible.
- Limits and assumptions are acknowledged honestly.
- Prose is clear, concrete, and respectful of reader time.
