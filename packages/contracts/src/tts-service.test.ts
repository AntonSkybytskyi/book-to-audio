import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  TTS_ERROR_CODES,
  TTS_ERROR_STATUS,
  type TtsServiceVoice,
  type TtsStoppingResponse,
  type TtsSynthesizeRequest,
  type TtsVoicesResponse,
} from "./tts-service.js";

interface Schema {
  required?: string[];
  properties?: Record<string, { enum?: string[] }>;
}
interface OpenApi {
  paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>>;
  components: { schemas: Record<string, Schema> };
}

const spec = parse(
  readFileSync(new URL("../openapi/tts-service.yaml", import.meta.url), "utf8"),
) as OpenApi;
const schema = (name: string): Schema => spec.components.schemas[name] ?? {};
const keys = (value: object) => Object.keys(value).toSorted();

describe("the TTS service OpenAPI file", () => {
  it("describes the three endpoints", () => {
    const endpoints = Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    );

    expect(endpoints.toSorted()).toEqual(["GET /health", "GET /voices", "POST /synthesize"]);
  });

  it("lists the same error codes as the types", () => {
    expect(schema("TtsServiceError").properties?.code?.enum).toEqual([...TTS_ERROR_CODES]);
  });

  it("documents one status per error code", () => {
    const responses = spec.paths["/synthesize"]?.post?.responses ?? {};
    const documented = Object.fromEntries(
      Object.entries(responses)
        .filter(([status]) => status !== "200")
        .map(([status, response]) => [/`(\w+)`/.exec(response.description)?.[1], Number(status)]),
    );

    expect(documented).toEqual(TTS_ERROR_STATUS);
  });

  it("documents the 503 of a service that is stopping", () => {
    const stopping = { status: "stopping" } satisfies TtsStoppingResponse;
    const response = spec.paths["/synthesize"]?.post?.responses["503"] as
      | { content: Record<string, { schema: { oneOf?: { $ref: string }[] } }> }
      | undefined;

    expect(response?.content["application/json"]?.schema.oneOf).toContainEqual({
      $ref: "#/components/schemas/TtsStoppingResponse",
    });
    expect(keys(schema("TtsStoppingResponse").properties ?? {})).toEqual(keys(stopping));
  });

  it("names the same fields as the types", () => {
    const voice = {
      id: "v",
      language: "en",
      name: "V",
      sampleRate: 22050,
      speaker: "s",
    } satisfies Required<TtsServiceVoice>;
    const voices = { voices: [], maxInputChars: 1, concurrency: 1 } satisfies TtsVoicesResponse;
    const request = { voice: "v", text: "t" } satisfies TtsSynthesizeRequest;

    expect(keys(schema("TtsServiceVoice").properties ?? {})).toEqual(keys(voice));
    expect(schema("TtsServiceVoice").required?.toSorted()).toEqual([
      "id",
      "language",
      "name",
      "sampleRate",
    ]);
    expect(keys(schema("TtsVoicesResponse").properties ?? {})).toEqual(keys(voices));
    expect(keys(schema("TtsSynthesizeRequest").properties ?? {})).toEqual(keys(request));
  });
});
