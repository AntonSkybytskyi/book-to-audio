# book-to-audio

Turn your own e-books into audiobooks. Upload an EPUB (later also PDF), pick the language, and the app reads every chapter aloud with a text-to-speech engine. You can play each chapter in the browser as soon as it is ready, and download the whole book as an M4B audiobook or as a ZIP of WebM chapter files. See the [application spec](docs/spec.md).

## Run with Docker

```bash
docker compose up --build
```

Open http://127.0.0.1:3000. The app is published on localhost only. Set `BOOK_TO_AUDIO_PORT` to use another host port. The app has no authentication, so keep the `127.0.0.1:` prefix if you change the port mapping or run the image with `docker run -p`.

Books, audio and the SQLite database live in the `book-data` volume (`/data` in the container), so they survive restarts and rebuilds. `docker compose down -v` deletes them.

## Develop

Requires Node.js 24 and pnpm (`corepack enable`).

```bash
pnpm install
pnpm dev
```

The dev server listens on `127.0.0.1:3000` and stores data in `./data`. Settings come from environment variables:

| Variable   | Default     | Meaning                                          |
| ---------- | ----------- | ------------------------------------------------ |
| `HOST`     | `127.0.0.1` | Address to listen on                             |
| `PORT`     | `3000`      | Port to listen on                                |
| `DATA_DIR` | `./data`    | Books, audio and `app.db`                        |
| `NODE_ENV` | —           | `development` (set by `pnpm dev`) runs Next.js in dev mode; anything else serves the built app |

Checks:

```bash
pnpm lint          # oxlint
pnpm format        # oxfmt (pnpm format:check to verify only)
pnpm typecheck
pnpm test          # vitest
pnpm check         # all of the above
```

The same checks run in the container with `docker compose run --rm check`.

## Layout

- `src/server`: Fastify server, config and SQLite (`db/migrations.ts` holds the schema migrations).
- `src/app`: Next.js App Router pages.
