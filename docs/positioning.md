# Positioning and differentiation

[日本語](positioning.ja.md)

Last reviewed: 2026-08-15.

`mcp-execution-handoff` is intentionally **not** a general human-in-the-loop framework, approval product, workflow engine, or browser automation system. It is a small security-oriented control-plane runtime for transferring execution authority from an Agent to a Human during an MCP-driven operation and deciding how execution may safely resume afterward.

The differentiation is therefore not “it can pause for a human.” Many established systems can already do that. The project differentiates itself by making a narrow set of handoff-specific security and replay semantics part of its explicit contract.

## The problem this project owns

When an MCP-driven operation reaches a step that cannot or should not be completed by the Agent, the project provides a reusable boundary for:

- exclusive Agent/Human execution authority;
- resource-epoch fencing across intervention rounds;
- principal + exact invocation + canonical-argument ownership binding;
- bounded signed control-plane checkpoints;
- explicit resume policy independent of Human completion;
- optional short-lived browser-takeover capabilities with a one-client lease;
- recovery by reissue-and-revalidate instead of restoration of stale execution authority;
- a hard separation between “the Human finished the manual step” and “the Human approved a consequential action.”

These invariants are part of this project's compatibility contract. Other frameworks may be configurable to implement similar policies; this document describes scope, not a claim of exclusive invention or superiority.

## Relationship to MCP itself

Current MCP specifications already provide standardized mechanisms for user interaction and long-running work:

- Multi Round-Trip Requests (MRTR) can return `input_required` and retry the original request with `inputResponses`.
- Elicitation supports both form mode and URL mode; URL mode keeps sensitive interaction data outside the MCP client.
- MCP Tasks can represent durable work that enters an `input_required` state.

This project should **compose with those mechanisms rather than replace them**.

What this project adds is a library-level security contract around the application state that surrounds those protocol mechanisms: authority ownership, epochs, invocation binding, checkpoint restrictions, takeover capability/lease semantics, and replay policy.

If a future MCP standard directly and sufficiently defines one of these mechanisms, the preferred direction is to adopt the standard and remove redundant project-specific plumbing.

Primary references:

- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://modelcontextprotocol.io/specification/draft/client/elicitation
- https://modelcontextprotocol.io/extensions/tasks/overview

## Relationship to workflow/HITL frameworks

### LangGraph / LangChain HITL

LangGraph interrupts can persist graph state, pause execution, and resume with external input. LangChain's HITL middleware adds human review decisions such as approve/edit/reject around tool calls.

`mcp-execution-handoff` does not attempt to replace graph persistence, agent orchestration, or generic approval middleware. Its narrower concern is the security boundary of **temporary execution-authority transfer** and the rules that prevent stale state or Human completion from becoming implicit replay/approval.

Reference:

- https://docs.langchain.com/oss/python/langgraph/interrupts
- https://docs.langchain.com/oss/python/langchain/human-in-the-loop

### Microsoft Agent Framework

Microsoft Agent Framework supports human-in-the-loop approval around function/tool execution. That is primarily an approval workflow: a sensitive tool can require a Human decision before execution.

This project deliberately keeps approval separate from handoff. A Human may need to perform a login, consent step, access challenge, or another manual intervention without approving the Agent's next consequential action. `Done` therefore never means `Approve` here.

Reference:

- https://learn.microsoft.com/en-us/agent-framework/integrations/ag-ui/human-in-the-loop

### HumanLayer / Agent Control Plane

Agent Control Plane provides durable agent execution, scheduling/control-loop infrastructure, and Human approval/input for MCP tools.

`mcp-execution-handoff` is intentionally much smaller: it is a reusable library-level control-plane primitive, not a scheduler, distributed agent runtime, communication service, or Kubernetes control plane.

Reference:

- https://github.com/humanlayer/agentcontrolplane

## Relationship to browser takeover systems

### Tencent BrowserSkill

BrowserSkill connects shell-capable Agents to a real logged-in browser and includes Human takeover for CAPTCHA, login, confirmation dialogs, and other Human-only steps.

That is a browser-automation product with a Human-in-loop capability. `mcp-execution-handoff` takes the inverse layering approach:

- browser automation is not provided by core;
- `browser-takeover` is optional transport only;
- consumer adapters decide which surfaces are eligible and verify domain-specific postconditions;
- the generic broker owns only bounded session/capability/lease mechanics;
- the takeover locator contains no capability;
- capability scope includes intervention/epoch/principal/client/expiry;
- one remote client generation owns the lease; reload/new-tab/new-device state cannot implicitly reclaim it, while an explicitly authenticated idle-session reconnect may rotate to a new fenced generation;
- Human completion does not authorize a later action.

Reference:

- https://github.com/Tencent/BrowserSkill

## Positioning summary

A concise description is:

> A security-oriented execution-handoff control plane for MCP workflows: temporarily transfer authority to a Human, fence stale state, bind the handoff to the exact caller/invocation, and resume only under an explicit replay policy.

The project should compete on **small, auditable, standards-aligned security semantics**, not on breadth of agent orchestration or browser automation features.

## What would erase the differentiation

The project should avoid drifting into any of the following:

- a generic `ask_human()` or approval UI wrapper with no stronger execution semantics;
- a workflow engine competing with LangGraph/agent runtimes;
- a browser automation engine competing with browser-agent products;
- custom protocol features that duplicate MCP MRTR/elicitation/Tasks;
- provider-specific challenge/login semantics in generic core;
- convenience APIs that silently weaken epoch, ownership, capability, or replay guarantees.

If the only remaining value becomes “pause and ask a Human,” the project no longer has a meaningful independent boundary.

## Review policy

Because MCP and agent frameworks evolve quickly, this document should be re-reviewed when:

- a new MCP specification changes MRTR, elicitation, Tasks, request state, or security guidance;
- a roadmap milestone proposes a new generic public API;
- browser takeover semantics change materially;
- a new real adapter requires changing the generic contract.
