# `.SKILL` — procedures this project teaches the agent

Every `.md` file here that opens with a frontmatter block is a **skill**: a
procedure the agent can load on demand with the `skill` tool.

The agent does **not** receive the bodies. It receives only each skill's `name`
and `description` in its system prompt, and loads a body when one matches the work
in front of it. That is why the description is the field that matters most — it is
the only thing the routing decision is made on.

## Layout

Two shapes, both supported:

    .SKILL/spring-boot-scaffold/SKILL.md    a bundle (use when the skill needs files beside it)
    .SKILL/spring-boot-scaffold.md          a flat file

## Frontmatter

    ---
    description: What this skill is for, in one line. The router reads this.
    ---

    Instructions, in Markdown. Naming the exact files and steps that are easy to
    forget is the whole point of the feature.

The **name** comes from the path — `spring-boot-scaffold/` or
`spring-boot-scaffold.md` — and must be kebab-case. There is deliberately no
`name:` field: one source of truth, so a file can never disagree with its own
directory.

## What the loader enforces

- A bundle (`<name>/SKILL.md`) is always treated as a skill, name or not.
- A flat `.md` file counts as a skill only if it opens with `---`. This README is
  skipped for exactly that reason.
- A skill that is malformed — not kebab-case, no `description`, or no
  instructions — is **reported in the agent's prompt** rather than silently
  ignored, so a typo shows up in the next turn instead of never.

## Where it is looked for

Upward from the session's working directory, so a repository root works from any
subdirectory. The nearest `.SKILL` directory wins.
