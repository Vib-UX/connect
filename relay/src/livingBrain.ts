import type { HostKind, PairInsight } from "./types.js";

const BRAIN_NAMES = ["Connect", "Connect sessions"];

/** Under this, the agent is about to return, so the insight recommends Flappy. */
export const RETURNING_MINUTES = 2;

const COST_WEIGHT = 40;
const SEAT_WEIGHT = 20;
const NOVELTY_WEIGHT = 15;
const WAIT_PER_MS = 1 / 4000;
const WAIT_CAP = 60;

export interface PairSeat {
  id: string;
  host: HostKind;
  costUsd: number;
  minutesLeft: number;
  waitedMs: number;
  recentOpponent: boolean;
  playedToday: boolean;
}

export interface BrainCaptureInput {
  text: string;
  originRef: string;
  label: string;
  connectId: string;
  host: string;
  model: string;
  costUsd: number;
  minutesLeft: number;
}

export interface BrainHit {
  title: string;
  summary: string;
  similarity: number;
}

/** The relay talks to Living Brain through this. Tests pass a fake. */
export interface BrainCapture {
  capture(input: BrainCaptureInput): Promise<{ id: string; status: string } | null>;
  search(query: string): Promise<BrainHit[]>;
}

export function livingBrainConfigured(): boolean {
  return Boolean(process.env.LIVING_BRAIN_API_KEY?.trim() && subjectId());
}

function subjectId(): string | null {
  const raw = process.env.LIVING_BRAIN_SUBJECT_ID?.trim() ?? "";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return raw;
  return null;
}

/** USD per million tokens. Same bands as the IDE prompt ledger. */
export function modelRates(model: string): { input: number; output: number } {
  const id = model.toLowerCase();
  if (id.includes("grok")) return { input: 2, output: 6 };
  if (id.includes("haiku") || id.includes("flash") || id.includes("mini")) return { input: 1, output: 5 };
  if (id.includes("opus") || id.includes("fable")) return { input: 15, output: 75 };
  return { input: 3, output: 15 };
}

/**
 * Price a prompt before the run finishes.
 * Input tokens are chars/4. Output is estimated at four times that, because the agent writes more than the prompt.
 */
export function predictPromptCost(prompt: string, model = ""): number {
  const input = Math.max(1, Math.ceil(prompt.trim().length / 4));
  const output = input * 4;
  const price = modelRates(model);
  return (input * price.input + output * price.output) / 1_000_000;
}

/** A small bill means the agent returns soon. An unknown cost assumes minutes remain. */
export function minutesFromCost(costUsd: number): number {
  if (!(costUsd > 0)) return 8;
  return Math.min(30, Math.max(0.25, costUsd / 0.002));
}

function money(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/** Higher is a better partner. A recent opponent scores lower and stays eligible. */
export function scorePair(
  me: PairSeat,
  them: PairSeat,
  similar?: string,
): { score: number; insight: PairInsight } {
  const gap = Math.abs(me.costUsd - them.costUsd);
  const scale = Math.max(me.costUsd, them.costUsd, 0.0001);
  const costScore = COST_WEIGHT * (1 - Math.min(1, gap / scale));
  const seatScore = me.host !== them.host ? SEAT_WEIGHT : 0;
  const noveltyScore = them.recentOpponent ? 0 : NOVELTY_WEIGHT;
  const waitScore = Math.min(WAIT_CAP, Math.max(0, them.waitedMs) * WAIT_PER_MS);
  const game: PairInsight["game"] =
    me.minutesLeft < RETURNING_MINUTES || them.minutesLeft < RETURNING_MINUTES ? "flappy" : "chess";
  const potUsd = Math.round(Math.min(me.costUsd, them.costUsd) * 10_000) / 10_000;
  const gameName = game === "chess" ? "Chess" : "Flappy";
  const today = them.playedToday ? "You have played today." : "First game today.";
  const extra = similar?.trim() ? ` ${similar.trim()}` : "";
  return {
    score: costScore + seatScore + noveltyScore + waitScore,
    insight: {
      potUsd,
      game,
      playedToday: them.playedToday,
      reason: `${money(potUsd)} covers both prompts. ${gameName} fits. ${today}${extra}`,
    },
  };
}

class SdkBrain implements BrainCapture {
  private client: import("@living-brain/sdk").LivingBrainClient | null = null;
  private brainId = process.env.LIVING_BRAIN_ID?.trim() || "";
  private opening: Promise<void> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly subject: string,
  ) {}

  private async open(): Promise<void> {
    if (this.client && this.brainId) return;
    if (!this.opening) {
      this.opening = this.resolve().catch((err) => {
        this.opening = null;
        throw err;
      });
    }
    await this.opening;
  }

  private async resolve(): Promise<void> {
    const { LivingBrainClient } = await import("@living-brain/sdk");
    const client = new LivingBrainClient({ apiKey: this.apiKey, subjectId: this.subject });
    this.client = client;
    if (this.brainId) return;
    const brains = await client.brains.list({ timeoutInSeconds: 8 });
    const found = BRAIN_NAMES.map((name) => brains.find((brain) => brain.name === name)).find(Boolean);
    if (found) {
      this.brainId = found.id;
      return;
    }
    const created = await client.brains.create(
      {
        name: "Connect",
        description: "Prompt reads for Connect matchmaking. The relay does not keep the text.",
      },
      { timeoutInSeconds: 8 },
    );
    this.brainId = created.id;
  }

  async capture(input: BrainCaptureInput): Promise<{ id: string; status: string } | null> {
    await this.open();
    if (!this.client || !this.brainId) return null;
    const source = await this.client.captures.capture(
      {
        brainId: this.brainId,
        body: {
          kind: "note",
          content: input.text,
          bucket: "notes",
          originRef: input.originRef,
          label: `${input.label} · ${input.model || "model"} · ${money(input.costUsd)}`,
          source: { channel: "connect", ref: input.connectId, label: input.host },
        },
      },
      { timeoutInSeconds: 8 },
    );
    return { id: source.id, status: source.status };
  }

  async search(query: string): Promise<BrainHit[]> {
    await this.open();
    if (!this.client || !this.brainId || !query.trim()) return [];
    const results = await this.client.workspace.searchPages(
      { brainId: this.brainId, query, topK: 3 },
      { timeoutInSeconds: 2 },
    );
    return results.map((hit) => ({
      title: hit.title,
      summary: hit.summary,
      similarity: hit.similarity,
    }));
  }
}

export function livingBrainFromEnv(): BrainCapture | null {
  const apiKey = process.env.LIVING_BRAIN_API_KEY?.trim();
  const subject = subjectId();
  if (!apiKey || !subject) return null;
  return new SdkBrain(apiKey, subject);
}
