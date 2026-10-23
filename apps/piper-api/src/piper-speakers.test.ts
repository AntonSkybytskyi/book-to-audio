import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { usePiperFixture, VOICE } from "./testing/piper-fixture.js";

const ukConfig = (speakers: Record<string, number>) => ({
  language: { family: "uk", code: "uk_UA" },
  num_speakers: Object.keys(speakers).length,
  speaker_id_map: speakers,
});

describe("PiperEngine speakers", () => {
  const fixture = usePiperFixture();
  const { engineWith } = fixture;

  const write = (name: string, config: object) => {
    fs.writeFileSync(path.join(fixture.voicesDir, `${name}.onnx`), "model");
    fs.writeFileSync(
      path.join(fixture.voicesDir, `${name}.onnx.json`),
      JSON.stringify({ audio: { sample_rate: 22050 }, ...config }),
    );
  };
  const requests = () =>
    fs
      .readFileSync(`${fixture.logFile}.requests`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  describe("a model with several speakers", () => {
    const UK = "uk_UA-ukrainian_tts-medium";

    it("lists a model with several speakers as one voice, for its default speaker", () => {
      write(UK, ukConfig({ lada: 0, mykyta: 1, tetiana: 2 }));

      const voice = engineWith()
        .voices()
        .find((v) => v.language === "uk");

      expect(voice).toEqual({
        id: `${UK}:lada`,
        language: "uk",
        name: `${UK}:lada`,
        sampleRate: 22050,
        speaker: "lada",
      });
    });

    it("sends the speaker's number with every chunk", async () => {
      write(UK, ukConfig({ tetiana: 0, lada: 7, mykyta: 1 }));
      const session = await engineWith().open(`${UK}:lada`);

      await session.synthesize("Привіт.");
      await session.synthesize("Ще раз.");
      await session.close();

      expect(requests().map((r) => r.speaker_id)).toEqual([7, 7]);
    });

    it("sends no speaker for a model with one speaker", async () => {
      const session = await engineWith().open(VOICE);

      await session.synthesize("Hello.");
      await session.close();

      expect(requests()[0]).not.toHaveProperty("speaker_id");
    });

    it("does not offer a model that lost the speaker it is used with", () => {
      write(UK, ukConfig({ mykyta: 1, tetiana: 2 }));

      expect(
        engineWith()
          .voices()
          .map((v) => v.language),
      ).toEqual(["en"]);
    });

    it("uses the first speaker of other multi-speaker models", async () => {
      write("xx_XX-choir-medium", {
        language: { family: "xx" },
        num_speakers: 2,
        speaker_id_map: { second: 5, first: 3 },
      });
      const voice = engineWith()
        .voices()
        .find((v) => v.language === "xx");
      expect(voice).toMatchObject({ id: "xx_XX-choir-medium:first", speaker: "first" });

      const session = await engineWith().open("xx_XX-choir-medium:first");
      await session.synthesize("Hi.");
      await session.close();
      expect(requests()[0]?.speaker_id).toBe(3);
    });

    it("does not know the bare model name of a multi-speaker voice", async () => {
      write(UK, ukConfig({ lada: 0, mykyta: 1 }));

      await expect(engineWith().open(UK)).rejects.toMatchObject({ code: "voice_not_found" });
    });

    it("puts the default voice of each language before the others", () => {
      write("en_GB-alan-low", { language: { family: "en" } });
      write("ru_RU-denis-medium", { language: { family: "ru" } });
      write("ru_RU-ruslan-medium", { language: { family: "ru" } });
      write(UK, ukConfig({ lada: 0, mykyta: 1 }));

      const ids = engineWith()
        .voices()
        .map((v) => v.id);

      expect(ids.slice(0, 3).toSorted()).toEqual([VOICE, "ru_RU-ruslan-medium", `${UK}:lada`]);
      expect(ids.indexOf("ru_RU-denis-medium")).toBeGreaterThan(ids.indexOf("ru_RU-ruslan-medium"));
      expect(ids.indexOf("en_GB-alan-low")).toBeGreaterThan(ids.indexOf(VOICE));
    });
  });
});
