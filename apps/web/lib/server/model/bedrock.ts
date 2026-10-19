import "server-only";

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import { ProviderError, type ProviderCall, type ProviderUsage } from "./types";

// Titan Text Embeddings V2 on Bedrock, behind ProviderCall<"embedding">. Credentials come
// from the Vercel OIDC role in AWS_ROLE_ARN (infra/aws, ADR 0009), never from AWS keys.
// The region comes only from BEDROCK_REGION and must be in the EU (AGENTS.md residency),
// never from the platform's own region variable. Nothing here logs, and errors carry only
// their kind, never SDK text.

// Same EU regions as the region SCP allows for Bedrock (infra/bootstrap README).
export const BEDROCK_EU_REGIONS = [
  "eu-central-1",
  "eu-north-1",
  "eu-west-1",
  "eu-west-3",
  "eu-south-1",
  "eu-south-2",
] as const;

const DIMENSIONS = 1024;
const CONCURRENCY = 4;

export type BedrockSend = (
  command: InvokeModelCommand,
  options: { abortSignal: AbortSignal },
) => Promise<{ body: Uint8Array }>;

type Env = Record<string, string | undefined>;

// One client per region and role, so the OIDC credentials are cached across calls.
const clients = new Map<string, BedrockRuntimeClient>();

function clientSend(region: string, roleArn: string): BedrockSend {
  const key = `${region}\n${roleArn}`;
  let client = clients.get(key);
  if (!client) {
    client = new BedrockRuntimeClient({
      region,
      // STS in the same EU region, not the global endpoint.
      credentials: awsCredentialsProvider({ roleArn, clientConfig: { region } }),
    });
    clients.set(key, client);
  }
  const bound = client;
  return async (command, options) => {
    const response = await bound.send(command, options);
    return { body: response.body };
  };
}

function errorKind(error: unknown): ProviderError["kind"] {
  const name = error instanceof Error ? error.name : "";
  if (name === "ThrottlingException" || name === "ServiceQuotaExceededException") return "throttled";
  if (name === "ModelTimeoutException" || name === "AbortError" || name === "TimeoutError") return "timeout";
  return "error";
}

const decoder = new TextDecoder();

// Returns null for anything that is not a 1024-dim finite vector with a token count.
function parseBody(body: Uint8Array): { vector: number[]; tokens: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(body));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { embedding, inputTextTokenCount } = parsed as Record<string, unknown>;
  if (!Array.isArray(embedding) || embedding.length !== DIMENSIONS) return null;
  if (!embedding.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  if (typeof inputTextTokenCount !== "number" || !Number.isInteger(inputTextTokenCount) || inputTextTokenCount < 0) {
    return null;
  }
  return { vector: embedding as number[], tokens: inputTextTokenCount };
}

export function createBedrockEmbeddings(deps: { send?: BedrockSend; env?: Env } = {}): ProviderCall<"embedding"> {
  return async ({ modelId, input, signal }) => {
    const env = deps.env ?? process.env;
    const region = env.BEDROCK_REGION?.trim() ?? "";
    const roleArn = env.AWS_ROLE_ARN?.trim() ?? "";
    if (!(BEDROCK_EU_REGIONS as readonly string[]).includes(region) || !roleArn) {
      throw new ProviderError("error");
    }
    if (signal.aborted) throw new ProviderError("timeout", { inputTokens: 0, outputTokens: 0 });

    const { texts } = input;
    if (texts.length === 0) return { output: { vectors: [] }, usage: { inputTokens: 0, outputTokens: 0 } };

    const send = deps.send ?? clientSend(region, roleArn);
    const vectors: number[][] = new Array<number[]>(texts.length);
    let inputTokens = 0;
    let next = 0;
    let failure: ProviderError["kind"] | null = null;

    // Each worker takes the next index until the list is done or any call failed.
    const worker = async (): Promise<void> => {
      while (failure === null && next < texts.length) {
        const index = next++;
        const command = new InvokeModelCommand({
          modelId,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({ inputText: texts[index], dimensions: DIMENSIONS, normalize: true }),
        });
        let body: Uint8Array;
        try {
          ({ body } = await send(command, { abortSignal: signal }));
        } catch (error) {
          failure ??= errorKind(error);
          return;
        }
        const parsed = parseBody(body);
        if (!parsed) {
          failure ??= "error";
          return;
        }
        vectors[index] = parsed.vector;
        inputTokens += parsed.tokens;
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker));

    const usage: ProviderUsage = { inputTokens, outputTokens: 0 };
    if (failure !== null) throw new ProviderError(failure, usage);
    return { output: { vectors }, usage };
  };
}

export const bedrockEmbeddings: ProviderCall<"embedding"> = createBedrockEmbeddings();
