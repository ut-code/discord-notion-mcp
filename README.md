# discord-notion-mcp

Discord ログインで使う、Discord / Notion 用のリモート MCP サーバー。

## ツール

| 権限           | ツール                                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discord:read` | `discord_list_channels` `discord_list_threads` `discord_read_messages` `discord_get_message` `discord_search_messages` `discord_find_member` `discord_list_pins` `discord_list_events` |
| `notion:read`  | `notion_search` `notion_get_page` `notion_query_database` `notion_get_database` `notion_get_comments`                                                                                  |
| `notion:write` | `notion_create_page` `notion_append_content` `notion_edit_content` `notion_update_properties` `notion_archive_page` `notion_list_recent_changes` `notion_revert_change`                |

- Discord は本人が閲覧できるチャンネルのみ。
- Notion の権限は Notion 連携に共有されたすべてのページ・データベースが対象。
- Notion の本文は Notion 公式の Markdown API（拡張 Markdown: メンション・色・コールアウト・トグル・カラム）で読み書きする。
- Notion への書き込みはページにコメントで記録され、`/dashboard/audit` または `notion_revert_change` で取り消せる。本文の追記・編集は変更前後の差分から逆編集を作って取り消す。変更後にページが編集されていた場合、`notion_revert_change` は取り消さず、ダッシュボードから管理者だけが強制的に取り消せる。子ページ・データベースを作るタグは本文に書けない。
- ツール呼び出しはユーザーごとに最大 30 回まで連続、以降は毎秒 1 回。

## セットアップ

### Discord

1. [Developer Portal](https://discord.com/developers/applications) でアプリを作成
2. OAuth2 → Redirects に `https://<domain>/api/auth/callback/discord`
3. Bot → Message Content Intent と Server Members Intent を ON、トークンを発行
4. `https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot&permissions=66560` で Bot をサーバーに招待

### Notion

1. [Integrations](https://www.notion.so/profile/integrations) で Internal integration を作成（Read / Update / Insert content、Read / Insert comments）
2. 公開したいページの「…」→ コネクト で追加

### Coolify

1. このリポジトリを Git リモートに push し、Coolify で Application（Build Pack: Dockerfile）として追加
2. Port `3000`、Domain を設定
3. Persistent Storage: `/data`
4. 環境変数を設定してデプロイ

## 環境変数

| 名前                    | 必須 | 内容                              |
| ----------------------- | ---- | --------------------------------- |
| `PUBLIC_URL`            | ✓    | `https://<domain>`                |
| `BETTER_AUTH_SECRET`    | ✓    | `openssl rand -base64 32`         |
| `DISCORD_CLIENT_ID`     | ✓    |                                   |
| `DISCORD_CLIENT_SECRET` | ✓    |                                   |
| `DISCORD_BOT_TOKEN`     | ✓    |                                   |
| `DISCORD_GUILD_ID`      | ✓    | 対象サーバー ID                   |
| `NOTION_TOKEN`          |      | 未設定なら Notion ツール無効      |
| `PORT`                  |      | 既定 `3000`                       |
| `DATABASE_PATH`         |      | 既定 `/data/app.db`（Docker）     |
| `TRUSTED_PROXY_COUNT`   |      | 既定 `1`。Cloudflare 経由なら `2` |

## 権限

- サーバーオーナーと Administrator 権限のロールは自動で `admin`（全権限）。
- それ以外は `https://<domain>/dashboard` でロールまたはユーザーに付与。
- 「トークンを失効」で即時に接続を切れる。
- ダッシュボードはサーバーのメンバー全員が閲覧できる（書き込み履歴は `notion:read` が必要）。権限ページと変更操作は管理者のみ。
- ツール呼び出しは統計用に記録し、90 日で削除する（引数は保存しない）。

## 接続

`https://<domain>/` に手順を表示する。

Claude Code:

```sh
claude mcp add --transport http --scope user discord-notion https://<domain>/mcp
```

Claude Code 内で `/mcp` を開いてログイン。

Codex:

```sh
codex mcp add discord-notion --url https://<domain>/mcp
codex mcp login discord-notion
```

## 開発

Bun + SvelteKit（adapter-node）+ shadcn-svelte / Tailwind CSS、Better Auth、MCP TypeScript SDK、Drizzle（bun:sqlite）。

画面の文言は `messages/ja.json`（Paraglide）。コードからは `m.<key>()` で参照する。

```sh
bun install
cp .env.example .env
bun run dev        # PUBLIC_URL のポート（.env の PORT）で起動
bun run preview    # 偽データで UI 確認: http://localhost:3920/dev
# 他端末から: tailscale serve --bg --https=8443 http://localhost:3920 && PREVIEW_PUBLIC_URL=https://<host>.ts.net:8443 bun run preview
bun test
bun run typecheck
bun run lint
bun run format
bun run build && bun run start
```
