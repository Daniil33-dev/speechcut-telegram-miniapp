# Speechcut public source

Install and maintain this existing VPS / OpenAI / AssemblyAI implementation.
Read docs/INSTALL.md, docs/FIXES.md and prompts/MASTER_PROMPT_RU.md.
Use each installer’s own accounts and isolated services. Do not modify unrelated
applications or publish runtime files, personal recordings, credentials or URLs.
Run pnpm run audit:public before publishing changes.

## Media invariants

- Remove only acoustically confirmed pauses strictly longer than 300 ms.
- Preserve at least 100 ms at applicable real speech boundaries. Do not protect
  entire stretched ASR intervals. Quiet short words and final syllables matter.
- Keep original word IDs and ASR timings immutable; spelling changes only affect
  captions. Deleting text removes those exact word IDs from video and audio.
- One edit map drives audio, video, subtitles and post-render verification.
- Render the exact approved version and settings snapshot. Edits revoke approval.
- Preserve the complete frame and aspect ratio, including rotation and SAR/DAR.
- Subtitles have measured 10% side margins, including outline, and at most two lines.
- Decode the finished MP4 before publication. PAUSE_CHECK_FAILED and
  WORD_CHECK_FAILED block publication and successful notifications.
- Word QA must compare rendered audio with source evidence, not just count IDs.
  Keep noise-floor calibration stable for output verification. Quiet supported
  speech must be excluded from pauses before the strict >300 ms decision.
- Checkpoints include rendererRevision and input hashes. Render-only retries
  never repeat ASR/LLM. Preserve prior artifacts and the usage ledger.
- Reproduce complaints on the actual recording when available; unit tests alone
  do not establish a media fix. Never claim listening without actual listening.

## Development and security

- Secrets belong in ignored .env.local or a protected server EnvironmentFile.
  Never print keys or include them in browser screenshots or logs.
- Development access is explicit and prohibited in production. No production
  demo transcript, successful fake provider response or fake progress.
- Long work runs in a separate durable worker. API requests only enqueue work.
- Ownership, revision conflicts, cancellation and late results are enforced
  by the server, including upload completion and artifact publication.
- Use bounded provider retries and record usage immediately and idempotently.
  Unknown expenses must remain unknown; they are not zero.
- Never remove actual user media without explicit authorization.
- Run check, test, test:media, doctor and build before production deployment.
- Read documentation shipped with the installed Next.js before editing its APIs.
- Saving: phones use prepared File + Web Share; desktops use Telegram's native
  downloadFile directly, even if navigator.canShare is available on macOS.
  Never reintroduce navigation links to MP4 or a second "Files" download action.
  A native download callback acknowledges the request, not a completed OS save.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
