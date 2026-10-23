import type Database from "better-sqlite3";

export interface LearnedSpeed {
  secondsPerKChar: number;
  slowdown: number;
  samples: number;
}

interface Row {
  seconds_per_kchar: number;
  slowdown: number;
  samples: number;
}

/** What real conversions taught the app about a voice (table `speed_learning`, migration 8). */
export class LearningRepository {
  constructor(private readonly db: Database.Database) {}

  get(engine: string, voiceId: string): LearnedSpeed | undefined {
    const row = this.db
      .prepare(
        "SELECT seconds_per_kchar, slowdown, samples FROM speed_learning WHERE engine = ? AND voice_id = ?",
      )
      .get(engine, voiceId) as Row | undefined;
    return (
      row && {
        secondsPerKChar: row.seconds_per_kchar,
        slowdown: row.slowdown,
        samples: row.samples,
      }
    );
  }

  save(engine: string, voiceId: string, learned: LearnedSpeed): void {
    this.db
      .prepare(
        `INSERT INTO speed_learning (engine, voice_id, seconds_per_kchar, slowdown, samples)
         VALUES (@engine, @voiceId, @secondsPerKChar, @slowdown, @samples)
         ON CONFLICT (engine, voice_id) DO UPDATE SET seconds_per_kchar = excluded.seconds_per_kchar,
           slowdown = excluded.slowdown, samples = excluded.samples,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run({ engine, voiceId, ...learned });
  }
}
