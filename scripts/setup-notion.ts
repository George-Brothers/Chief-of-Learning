/**
 * One-time: create Lucy's Notion workspace under a parent page shared with the integration.
 * Usage: npm run setup:notion -- <PARENT_PAGE_ID>
 * Prints the ids to paste into .env.local (and later Vercel env).
 */
import { Client } from "@notionhq/client";

const token = process.env.NOTION_TOKEN;
const parentId = process.argv[2] || process.env.NOTION_PARENT_PAGE_ID;

if (!token) throw new Error("NOTION_TOKEN missing (run via `npm run setup:notion`).");
if (!parentId) throw new Error("Pass the parent page id: npm run setup:notion -- <PAGE_ID>");

const notion = new Client({ auth: token });
const sel = (...names: string[]) => ({ select: { options: names.map((name) => ({ name })) } });

async function main() {
  const parent = { type: "page_id" as const, page_id: parentId! };

  const evidence = await notion.databases.create({
    parent,
    title: [{ type: "text", text: { content: "Evidence Inbox" } }],
    properties: {
      Name: { title: {} },
      Type: sel("lesson-note", "homework", "check-in", "srs-screenshot", "question"),
      Raw: { rich_text: {} },
      Image: { url: {} },
      Source: sel("telegram", "manual"),
      Processed: { checkbox: {} },
      Distilled: { rich_text: {} },
    },
  });

  const lessons = await notion.databases.create({
    parent,
    title: [{ type: "text", text: { content: "Lessons" } }],
    properties: {
      Name: { title: {} },
      Date: { rich_text: {} },
      Hash: { rich_text: {} },
      Summary: { rich_text: {} },
      WeakSignals: { rich_text: {} },
      Homework: { rich_text: {} },
      VocabCount: { number: {} },
      Note: { rich_text: {} },
      Processed: { checkbox: {} },
    },
  });

  const actionQueue = await notion.databases.create({
    parent,
    title: [{ type: "text", text: { content: "Action Queue" } }],
    properties: {
      Name: { title: {} },
      Type: sel("create_anki_cards", "assign_reading", "queue_drill"),
      Payload: { rich_text: {} },
      Status: sel("queued", "done", "error"),
      Result: { rich_text: {} },
    },
  });

  const syllabus = await notion.databases.create({
    parent,
    title: [{ type: "text", text: { content: "Syllabus Index" } }],
    properties: {
      Chapter: { title: {} },
      Section: sel("textbook", "workbook", "character-workbook"),
      Vocab: { rich_text: {} },
      Grammar: { rich_text: {} },
    },
  });

  const decks = await notion.databases.create({
    parent,
    title: [{ type: "text", text: { content: "Decks" } }],
    properties: {
      Name: { title: {} },
      Source: sel("tutor-note", "textbook", "manual"),
      Count: { number: {} },
      Headwords: { rich_text: {} },
      Deck: { rich_text: {} },
    },
  });

  const assignments = await notion.databases.create({
    parent,
    title: [{ type: "text", text: { content: "Assignments" } }],
    properties: {
      Name: { title: {} },
      Type: sel("reading", "drill", "homework"),
      Description: { rich_text: {} },
      Status: sel("open", "done"),
      Created: { rich_text: {} },
    },
  });

  const planPage = await notion.pages.create({
    parent,
    properties: { title: { title: [{ type: "text", text: { content: "Plan" } }] } },
  });

  const todayPage = await notion.pages.create({
    parent,
    properties: { title: { title: [{ type: "text", text: { content: "Today" } }] } },
  });

  // HSK Scorecard: computed coverage (code-owned) + grammar/skills checklist (teacher-owned).
  // No seed body — the first daily-brief run writes it.
  const scorecardPage = await notion.pages.create({
    parent,
    properties: { title: { title: [{ type: "text", text: { content: "HSK Scorecard" } }] } },
  });

  const retainedPage = await notion.pages.create({
    parent,
    properties: { title: { title: [{ type: "text", text: { content: "Retained (SRS-confirmed words)" } }] } },
  });

  const listeningPage = await notion.pages.create({
    parent,
    properties: { title: { title: [{ type: "text", text: { content: "Listening (checks + results)" } }] } },
  });

  console.log("\n=== Paste these into .env.local (and Vercel env) ===\n");
  console.log(`NOTION_EVIDENCE_DB_ID=${evidence.id}`);
  console.log(`NOTION_LESSONS_DB_ID=${lessons.id}`);
  console.log(`NOTION_ACTIONQUEUE_DB_ID=${actionQueue.id}`);
  console.log(`NOTION_SYLLABUS_DB_ID=${syllabus.id}`);
  console.log(`NOTION_DECKS_DB_ID=${decks.id}`);
  console.log(`NOTION_PLAN_PAGE_ID=${planPage.id}`);
  console.log(`NOTION_TODAY_PAGE_ID=${todayPage.id}`);
  console.log(`NOTION_SCORECARD_PAGE_ID=${scorecardPage.id}`);
  console.log(`NOTION_ASSIGNMENTS_DB_ID=${assignments.id}`);
  console.log(`NOTION_RETAINED_PAGE_ID=${retainedPage.id}`);
  console.log(`NOTION_LISTENING_PAGE_ID=${listeningPage.id}`);
  console.log("\nDone. Lucy's Notion space is ready.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
