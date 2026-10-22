# Bismuth

Obsidian の vault をそのままデータベースとして使う、ローカル起動のタスク管理 Web アプリです。

タスクは1件につき1つの Markdown ノートとして vault に置き、状態（ステータス、優先度、期限など）はノートの frontmatter に書きます。
Bismuth はそのノートを読み書きするビューと操作台であり、独自のデータベースを持ちません。
そのため、Obsidian からノートを直接編集しても、Bismuth の画面にそのまま反映されます。
Obsidian の同期機能や Git で vault を共有すれば、複数のマシンで同じタスクを扱えます。

## 主な機能

- カンバン形式のボード（IceBox、Backlog、Ready、In Progress、Done）とドラッグによるステータス変更
- カラムごとの並べ替え（優先度、期限、プロジェクト、完了日、タスク番号、更新日、手動）
- タスクの起票と編集（タイトル、ステータス、優先度、期限、繰り返し、見積時間、タグ、概要、サブタスク）
- 繰り返しタスク（毎日、毎週、隔週、毎月、曜日指定、N 日ごと）
- タスクへのコメントと作業記録の追記
- プロジェクト、優先度、タグ、期限による絞り込み
- 終わったプロジェクトのアーカイブ（ノートは残したまま、ボードから隠す）
- ターミナルから一覧の表示や起票、完了、コメントができる CLI
- ダークテーマとライトテーマ

## 必要なもの

- Node.js 20 以上
- タスクノートを置くフォルダ（Obsidian の vault を想定していますが、Markdown ファイルを置ける普通のフォルダでも動きます）

## 使い方

インストールせずに、次のコマンドで起動できます。

```sh
npx bismuth-tasks
```

初回の起動では、タスクノートを置く vault の場所を尋ねられます。
入力した場所は `~/.config/bismuth/config.json` に保存され、次回からは尋ねられません。
起動するとブラウザで http://localhost:8383 が開きます。
ポート番号は、ビスマスの原子番号 83 にちなんでいます。

毎回 `npx` で取得せずに使いたい場合は、グローバルにインストールします。

```sh
npm install -g bismuth-tasks
bismuth-tasks
```

主なオプションは次のとおりです。

```sh
bismuth-tasks --port 8400         # ポートを変える
bismuth-tasks --vault ~/notes     # 今回だけ別の vault を使う（設定は書き換えない）
bismuth-tasks --no-open           # ブラウザを開かない
bismuth-tasks --help
```

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
repeat:
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

- **status**：`icebox`、`backlog`、`ready`、`inprogress`、`done`、`dropped`（やらない）のいずれか
- **priority**：`P1`（最優先）から `P4` まで。空欄は優先度なし
- **due**：期限（`YYYY-MM-DD`）
- **repeat**：繰り返しのルール。空欄は繰り返さない（後述の「繰り返しタスク」を参照）
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

### 繰り返しタスク

`repeat` にルールを書いたタスクは、done にすると完了にならず、期限を次回へ進めて backlog に戻ります。
ノートは1つのまま使い回します。

| repeat | 意味 |
|---|---|
| `daily` | 毎日 |
| `weekly` | 毎週（期限と同じ曜日） |
| `biweekly` | 隔週 |
| `monthly` | 毎月（期限と同じ日。その日が無い月は月末） |
| `weekly:mon,thu` | 指定した曜日（`sun` `mon` `tue` `wed` `thu` `fri` `sat`） |
| `every:3d` | N 日ごと |

次回の期限は、今の期限（無ければ完了した日）からルールに従って進めます。
進めた日が今日以前なら、今日より後になるまで進めます。
期限を何回分か過ぎてから完了しても、次に出るのは1回分だけです。

done にしたときは次のことも行います。

- `## コメント` に「繰り返し: 完了（期限 2026-07-20）→ 次回期限 2026-07-21」の形で履歴を1件追記する
- `## サブタスク` のチェック済みの項目を未完了に戻す

繰り返しをやめて完了にするときは、`repeat` を空にしてから done にします。
Obsidian で `status` を直接 `done` に書き換えた場合は、繰り返しの処理は行われません。

## 設定

設定は保存場所の異なる2種類に分かれています。

- **ユーザー設定**：マシンごとの設定です。vault の場所、フォルダ構成、表示項目、並べ替え、テーマを `~/.config/bismuth/config.json` に保存します。保存先は環境変数 `BISMUTH_CONFIG` で変更できます。
- **システム設定**：vault と一緒に共有する設定です。プロジェクトの一覧と、次に採番するタスク番号を `<vault>/.bismuth/config.json` に保存します。

次のタスク番号は、起票のたびに vault 全体を走査しないための控えです。
このファイルを消しても、次の起動時に vault の最大のタスク番号から作り直します。

## CLI

サーバを起動しなくても、ターミナルから vault を直接読み書きできます。
`npx` で使う場合は、`bismuth-tasks` を `npx bismuth-tasks` に読み替えてください。

```sh
bismuth-tasks cli                             # ボード表示
bismuth-tasks cli --list                      # フラットな一覧
bismuth-tasks cli --json                      # JSON 出力
bismuth-tasks cli --list --all                # アーカイブ済みプロジェクトのタスクも含める
bismuth-tasks cli --project alpha --status ready,inprogress --priority P1,P2 --due 1week
bismuth-tasks cli create --project alpha --title "ログイン画面の不具合調査" --priority P2
bismuth-tasks cli create --project alpha --title "日次レビュー" --due 2026-07-20 --repeat daily
bismuth-tasks cli done alpha-12               # 完了にする（繰り返しタスクは次回の期限で backlog に戻る）
bismuth-tasks cli comment alpha-12 "原因を特定した" --author "作業メモ"
bismuth-tasks cli tag alpha-12 --add waiting  # タグを付け外しする
bismuth-tasks cli --help
```

タスクの指定は `alpha-12` と `12` のどちらの形でもできます。
ボード表示と `--list` は、アーカイブ済みプロジェクトのタスクを既定で表示しません。`--json` は常に全件を出力します。

## 開発

```sh
git clone https://github.com/vicestudiojp/bismuth.git
cd bismuth
npm install
npm run dev:server   # API サーバ（ポート 8383）
npm run dev:web      # Vite の開発サーバ（ポート 5183。/api は 8383 へ転送）
```

ディレクトリの構成は次のとおりです。

- `server/`：Fastify と TypeScript による API サーバと CLI
- `web/`：React と Vite による画面
- `bin/`：`bismuth-tasks` コマンドの入口

`npm run build` で `dist/` にサーバと画面をビルドし、`npm run app` でビルドしてから起動します。
CLI は `npm run cli -- <引数>` で、ビルドせずに動かせます。

`server/scripts/verify-*.ts` は、一時フォルダに小さな vault を作って動作を確かめる検証スクリプトです。
実際の vault には触れません。
`npm run verify` ですべて実行できます。

## ライセンス

Copyright (C) 2026 ViceStudio

このプログラムはフリーソフトウェアです。
GNU General Public License バージョン 3 の条件のもとで、再配布や改変ができます。
全文は [LICENSE](LICENSE) を参照してください。
