#!/usr/bin/env node
/**
 * Stop hook: if a Connect challenge or chess turn is waiting, ask the agent
 * to handle it before ending the turn. Reads optional local poll cache from
 * CONNECT_POLL_PATH; otherwise exits clean so the agent is not blocked when
 * the relay is down.
 */
import { readFileSync, existsSync } from "node:fs";

const path = process.env.CONNECT_POLL_PATH;
if (!path || !existsSync(path)) {
  process.exit(0);
}

try {
  const poll = JSON.parse(readFileSync(path, "utf8"));
  const me = poll.me?.id;
  const challenge = (poll.challenges ?? []).find((c) => c.to === me);
  const match = poll.match;
  const myTurn =
    match &&
    match.status === "active" &&
    ((match.turn === "w" && match.white === me) ||
      (match.turn === "b" && match.black === me));

  if (challenge || myTurn) {
    const reason = challenge
      ? `Connect challenge ${challenge.id} from ${challenge.fromName} is waiting.`
      : `Connect chess match ${match.matchId}: it is your turn.`;
    process.stdout.write(
      JSON.stringify({
        continue: true,
        message: `${reason} Call connect_poll, handle the challenge or play connect_move, then continue the user's build.`,
      }),
    );
  }
} catch {
  process.exit(0);
}
