# Bismuth

Obsidian の vault をそのままデータベースとして使う、ローカル起動のタスク管理 Web アプリです。

タスクは1件につき1つの Markdown ノートとして vault に置き、状態（ステータス、優先度、期限など）はノートの frontmatter に書きます。
Bismuth はそのノートを読み書きするビューと操作台であり、独自のデータベースを持ちません。
そのため、Obsidian からノートを直接編集しても、Bismuth の画面にそのまま反映されます。
Obsidian の同期機能や Git で vault を共有すれば、複数のマシンで同じタスクを扱えます。

## 主な機能

- カンバン形式のボード（IceBox、Backlog、DoToday、In Progress、Done）とドラッグによるステータス変更
- カラムごとの並べ替え（優先度、期限、プロジェクト、完了日、タスク番号、更新日、手動）
- タスクの起票と編集（タイトル、ステータス、優先度、期限、見積時間、タグ、概要、サブタスク）
- タスクへのコメントと作業記録の追記
- プロジェクト、優先度、タグ、期限による絞り込み
- ターミナルから一覧の表示や起票、完了、コメントができる CLI
- ダークテーマとライトテーマ

## 必要なもの

- Node.js 20 以上
- タスクノートを置くフォルダ（Obsidian の vault を想定していますが、Markdown ファイルを置ける普通のフォルダでも動きます）

## セットアップ

```sh
git clone <このリポジトリの URL> bismuth
cd bismuth
npm install
```

次に、vault の場所を設定ファイル `~/.config/bismuth/config.json` に書きます。

```json
{
  "root": "~/path/to/your/vault"
}
```

設定ファイルがない場合は `~/bismuth` を vault とみなします。
環境変数 `BISMUTH_VAULT` を指定すると、設定ファイルより優先されます。

## 起動

```sh
npm run app
```

ブラウザで http://localhost:8383 を開きます。
ポート番号は、ビスマスの原子番号 83 にちなんでいます。
環境変数 `BISMUTH_PORT` で変更できます。

起動後は、画面右上の設定ボタンから vault の場所やタスクフォルダを変更できます。

## タスクノートの形式

タスクノートは `<vault>/_task/<プロジェクト>/` に、`<プロジェクト>-task-<番号>-<タイトル>.md` という名前で作られます。
タスク番号は vault 全体で通し番号です。

```markdown
---
task-id: 12
title: ログイン画面の不具合調査
project: alpha
status: backlog
priority: P2
due: 2026-07-20
tags: [waiting]
estimate: 2
parent:
order:
created: 2026-07-10
updated: 2026-07-10
completed:
---

# 12 ログイン画面の不具合調査

## 概要

（タスクの説明）

## サブタスク

- [ ] 再現手順を確認する
- [ ] 原因を特定する

## 作業記録

| Start | End | Memo |
|---|---|---|

## コメント

## 成果物・関連リンク
```

frontmatter の各項目は次のとおりです。

- **status**：`icebox`、`backlog`、`dotoday`、`inprogress`、`done`、`dropped`（やらない）のいずれか
- **priority**：`P1`（最優先）から `P4` まで。空欄は優先度なし
- **due**：期限（`YYYY-MM-DD`）
- **estimate**：見積時間（時間単位）
- **order**：並べ替えを「手動」にしたときの並び順

frontmatter に `task-id` があるノートだけをタスクとして扱います。
Obsidian で同じ形式のノートを手で作れば、次の読み込みから Bismuth にも表示されます。

Bismuth が書き換えるのは frontmatter と、`## 概要`、`## サブタスク`、`## 作業記録`、`## コメント` の各セクションです。
それ以外のセクションには手を加えないので、自由に書き足せます。
タイトルを変更したときは、ファイル名と先頭の見出しも新しいタイトルに合わせて変わります。
他のノートからの `[[リンク]]` は自動では書き換わらないので、必要なら Obsidian 側で更新してください。
タスクを削除すると、ノートは `_task/.trash/` に移ります。
ファイル自体は消えないので、元のフォルダに戻せば復元できます。

## 設定

設定は保存場所の異なる2種類に分かれています。

- **ユーザー設定**：マシンごとの設定です。vault の場所、フォルダ構成、表示項目、並べ替え、テーマを `~/.config/bismuth/config.json` に保存します。保存先は環境変数 `BISMUTH_CONFIG` で変更できます。
- **システム設定**：vault と一緒に共有する設定です。プロジェクトの一覧と、次に採番するタスク番号を `<vault>/.bismuth/config.json` に保存します。

次のタスク番号は、起票のたびに vault 全体を走査しないための控えです。
このファイルを消しても、次の起動時に vault の最大のタスク番号から作り直します。

## CLI

サーバを起動しなくても、ターミナルから vault を直接読み書きできます。

```sh
npm run cli                                   # ボード表示
npm run cli -- --list                         # フラットな一覧
npm run cli -- --json                         # JSON 出力
npm run cli -- --project alpha --status dotoday,inprogress --priority P1,P2 --due 1week
npm run cli -- create --project alpha --title "ログイン画面の不具合調査" --priority P2
npm run cli -- done alpha-12                  # 完了にする
npm run cli -- comment alpha-12 "原因を特定した" --author "作業メモ"
npm run cli -- tag alpha-12 --add waiting     # タグを付け外しする
npm run cli -- --help
```

タスクの指定は `alpha-12` と `12` のどちらの形でもできます。

## 開発

```sh
npm run dev:server   # API サーバ（ポート 8383）
npm run dev:web      # Vite の開発サーバ（ポート 5183。/api は 8383 へ転送）
```

構成は npm workspaces です。

- `server/`：Fastify と TypeScript による API サーバと CLI
- `web/`：React と Vite による画面

`server/scripts/verify-*.ts` は、一時フォルダに小さな vault を作って動作を確かめる検証スクリプトです。
実際の vault には触れません。

```sh
cd server
npx tsx scripts/verify-update.ts
```
