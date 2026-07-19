/**
 * One-time: read Integrated Chinese PDFs from materials/ and build the Syllabus Index.
 * Usage: drop PDFs in materials/, ensure the provider key + NOTION_* are set, then:
 *   npm run ingest:materials
 * Runs one extraction per PDF; each becomes chapter rows (vocab + grammar) in Notion.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// Import the implementation file directly to avoid pdf-parse's debug-on-require behavior.
import pdf from "pdf-parse/lib/pdf-parse.js";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { Client } from "@notionhq/client";
import { MODEL_DEFAULTS } from "../lib/models";

const NOTION_TOKEN = process.env.NOTION_TOKEN!;
const SYLLABUS_DB = process.env.NOTION_SYLLABUS_DB_ID!;
// Offline long-context extraction → same routing policy as the app's long role (Gemini Flash),
// overridable via MODEL_LONG. Builds the direct provider from the slug so it stays decoupled from
// the app's full env schema (this script only sets NOTION_* + the one provider key it needs).
const SLUG = process.env.MODEL_LONG ?? MODEL_DEFAULTS.long;
if (!NOTION_TOKEN || !SYLLABUS_DB) throw new Error("NOTION_TOKEN and NOTION_SYLLABUS_DB_ID required.");

function buildModel(slug: string): LanguageModel {
  const [provider, ...rest] = slug.split("/");
  const modelId = rest.join("/");
  if (provider === "deepseek") {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error(`DEEPSEEK_API_KEY required for "${slug}".`);
    return createDeepSeek({ apiKey })(modelId);
  }
  if (provider === "google") {
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) throw new Error(`GOOGLE_GENERATIVE_AI_API_KEY required for "${slug}" (or set MODEL_LONG=deepseek/…).`);
    return createGoogleGenerativeAI({ apiKey })(modelId);
  }
  throw new Error(`Invalid MODEL_LONG slug "${slug}" — expected "deepseek/<id>" or "google/<id>".`);
}
const MODEL = buildModel(SLUG);

const notion = new Client({ auth: NOTION_TOKEN });

const ChaptersSchema = z.object({
  chapters: z.array(
    z.object({
      chapter: z.string(),
      section: z.enum(["textbook", "workbook", "character-workbook"]),
      vocab: z.string(), // space-separated headwords, or "headword pinyin" pairs
      grammar: z.string(),
    })
  ),
});

function sectionFromName(name: string): "textbook" | "workbook" | "character-workbook" {
  const n = name.toLowerCase();
  if (n.includes("character")) return "character-workbook";
  if (n.includes("workbook")) return "workbook";
  return "textbook";
}

async function main() {
  const files = readdirSync("materials").filter((f) => f.toLowerCase().endsWith(".pdf"));
  if (!files.length) {
    console.log("No PDFs in materials/. Drop the Integrated Chinese PDFs there and re-run.");
    return;
  }

  for (const file of files) {
    console.log(`Reading ${file}...`);
    const buf = readFileSync(join("materials", file));
    const { text } = await pdf(buf);
    const section = sectionFromName(file);

    const { object } = await generateObject({
      model: MODEL,
      schema: ChaptersSchema,
      system:
        "You extract a clean chapter-by-chapter syllabus from Chinese textbook text. Be accurate and concise.",
      prompt: `This is text from "${file}" (an Integrated Chinese ${section}). Break it into chapters. For each chapter give: chapter label, the vocab list (space-separated Chinese headwords, ideally with pinyin), and key grammar points (semicolon-separated). Text:\n\n${text.slice(0, 120_000)}`,
    });

    for (const ch of object.chapters) {
      await notion.pages.create({
        parent: { database_id: SYLLABUS_DB },
        properties: {
          Chapter: { title: [{ text: { content: `${ch.chapter} (${section})` } }] },
          Section: { select: { name: ch.section } },
          Vocab: { rich_text: [{ text: { content: ch.vocab.slice(0, 1900) } }] },
          Grammar: { rich_text: [{ text: { content: ch.grammar.slice(0, 1900) } }] },
        },
      });
    }
    console.log(`  + ${object.chapters.length} chapters from ${file}`);
  }
  console.log("Syllabus Index built.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
