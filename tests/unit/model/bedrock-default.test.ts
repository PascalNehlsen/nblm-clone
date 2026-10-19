// PR B (block C: Bedrock embeddings): the default path of lib/server/model/bedrock.ts --
// no injected `send`, so the module must build a real BedrockRuntimeClient itself, using
// Vercel's OIDC credentials provider (AGENTS.md: "reached from Vercel through OIDC, no AWS
// keys") and the EU region from BEDROCK_REGION (never AWS_REGION). Kept in its own file
// because vi.mock of @aws-sdk/client-bedrock-runtime and @vercel/functions/oidc applies to
// the whole file, which would get in the way of the injected-send tests in bedrock.test.ts.
// No real network call is made: BedrockRuntimeClient itself is replaced by a fake class.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderRequest } from "@/lib/server/model/types";

// vi.mock factories are hoisted above regular `const` declarations, so anything they
// close over (the mocks, the sentinel) must be created inside vi.hoisted, which is
// hoisted together with them (same pattern as call-production.test.ts).
const { CREDENTIALS_SENTINEL, clientConstructorMock, sendMock, awsCredentialsProviderMock } = vi.hoisted(() => {
  const CREDENTIALS_SENTINEL = { sentinel: "aws-credentials-sentinel" };
  return {
    CREDENTIALS_SENTINEL,
    clientConstructorMock: vi.fn(),
    sendMock: vi.fn<(command: unknown, options: unknown) => Promise<{ body: Uint8Array }>>(async () => ({
      body: new TextEncoder().encode(
        JSON.stringify({ embedding: Array.from({ length: 1024 }, () => 0.1), inputTextTokenCount: 4 }),
      ),
    })),
    awsCredentialsProviderMock: vi.fn<
      (init: { roleArn: string; clientConfig?: { region?: string } }) => typeof CREDENTIALS_SENTINEL
    >(() => CREDENTIALS_SENTINEL),
  };
});

vi.mock("@vercel/functions/oidc", () => ({
  awsCredentialsProvider: awsCredentialsProviderMock,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-bedrock-runtime")>();
  class FakeBedrockRuntimeClient {
    constructor(config: unknown) {
      clientConstructorMock(config);
    }
    send(command: unknown, options: unknown) {
      return sendMock(command, options);
    }
  }
  return { ...actual, BedrockRuntimeClient: FakeBedrockRuntimeClient };
});

import { createBedrockEmbeddings } from "@/lib/server/model/bedrock";

afterEach(() => {
  vi.clearAllMocks();
});

describe("createBedrockEmbeddings: default path (no injected send)", () => {
  it(
    "constructs BedrockRuntimeClient with the Bedrock region and the OIDC credentials (no logger), " +
      "calls awsCredentialsProvider with the configured roleArn, and sends with the request's abortSignal",
    async () => {
      const env = { BEDROCK_REGION: "eu-west-1", AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/test-role" };
      const provider = createBedrockEmbeddings({ env });
      const controller = new AbortController();
      const request: ProviderRequest<"embedding"> = {
        modelId: "amazon.titan-embed-text-v2:0",
        maxOutputTokens: 0,
        input: { texts: ["hello"] },
        signal: controller.signal,
      };

      const result = await provider(request);

      expect(result.output.vectors).toHaveLength(1);

      expect(clientConstructorMock).toHaveBeenCalled();
      const clientConfig = clientConstructorMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(clientConfig.region).toBe("eu-west-1");
      expect(clientConfig.credentials).toBe(CREDENTIALS_SENTINEL);
      expect(Object.keys(clientConfig)).not.toContain("logger");

      expect(awsCredentialsProviderMock).toHaveBeenCalledWith(
        expect.objectContaining({ roleArn: "arn:aws:iam::123456789012:role/test-role" }),
      );
      // The implementation calls awsCredentialsProvider({ roleArn, clientConfig: { region } })
      // so STS is reached in the same EU region as the Bedrock client itself. Cast to the
      // mock's exact parameter type (not a hand-picked subset) so the cast target is one of
      // the union members of `calls[0]?.[0]`'s type, same pattern as call.test.ts.
      const credentialsCallArg = awsCredentialsProviderMock.mock.calls[0]?.[0] as {
        roleArn: string;
        clientConfig?: { region?: string };
      };
      expect(credentialsCallArg.clientConfig?.region).toBe("eu-west-1");

      expect(sendMock).toHaveBeenCalledTimes(1);
      const sendOptions = sendMock.mock.calls[0]?.[1] as { abortSignal: AbortSignal };
      expect(sendOptions.abortSignal).toBe(controller.signal);
    },
  );
});
