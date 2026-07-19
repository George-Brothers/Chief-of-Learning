/**
 * One-time: create Lucy's four-doc brain in Notion (Ledger, Study Map, Daily Log, Gradebook),
 * seeded with the example content in seed/data.ts, and load the Integrated Chinese vocab spine
 * into the Syllabus Index. Prints the 4 page ids for .env.local + Vercel.
 * Usage: npm run seed:knowledge -- <PARENT_PAGE_ID>
 */
import { Client } from "@notionhq/client";
import { LEDGER, STUDY_MAP, DAILY_LOG, GRADEBOOK, SYLLABUS } from "../seed/data";

const token = process.env.NOTION_TOKEN;
const syllabusDb = process.env.NOTION_SYLLABUS_DB_ID;
const parentId = process.argv[2] || process.env.NOTION_PARENT_PAGE_ID;

if (!token) throw new Error("NOTION_TOKEN missing (run via `npm run seed:knowledge`).");
if (!parentId) throw new Error("Pass the parent page id: npm run seed:knowledge -- <PAGE_ID>");

const notion = new Client({ auth: token });

const toRichText = (s: string) => {
  const chunks: string[] = [];
  for (let i = 0; i < s.length; i += 1900) chunks.push(s.slice(i, i + 1900));
  return chunks.map((content) => ({ text: { content } }));
};

async function createDoc(title: string, body: string): Promise<string> {
  const page = (await notion.pages.create({
    parent: { type: "page_id", page_id: parentId! },
    properties: { title: { title: [{ type: "text", text: { content: title } }] } },
  })) as { id: string };

  const children = body.split("\n").map((line) => ({
    object: "block" as const,
    type: "paragraph" as const,
    paragraph: { rich_text: toRichText(line) },
  }));
  for (let i = 0; i < children.length; i += 90) {
    await notion.blocks.children.append({ block_id: page.id, children: children.slice(i, i + 90) });
  }
  return page.id;
}

async function main() {
  const ledger = await createDoc("Knowledge Ledger", LEDGER);
  const studyMap = await createDoc("Study Map", STUDY_MAP);
  const dailyLog = await createDoc("Daily Log", DAILY_LOG);
  const gradebook = await createDoc("Gradebook", GRADEBOOK);

  if (syllabusDb) {
    for (const row of SYLLABUS) {
      await notion.pages.create({
        parent: { database_id: syllabusDb },
        properties: {
          Chapter: { title: [{ text: { content: row.chapter } }] },
          Section: { select: { name: row.section } },
          Vocab: { rich_text: toRichText(row.vocab) },
          Grammar: { rich_text: toRichText(row.grammar) },
        },
      });
    }
    console.log(`Seeded ${SYLLABUS.length} syllabus rows.`);
  } else {
    console.log("NOTION_SYLLABUS_DB_ID not set — skipped syllabus.");
  }

  console.log("\n=== Paste into .env.local (and Vercel env) ===\n");
  console.log(`NOTION_LEDGER_PAGE_ID=${ledger}`);
  console.log(`NOTION_STUDYMAP_PAGE_ID=${studyMap}`);
  console.log(`NOTION_DAILYLOG_PAGE_ID=${dailyLog}`);
  console.log(`NOTION_GRADEBOOK_PAGE_ID=${gradebook}`);
  console.log("\nLucy's brain is seeded.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
