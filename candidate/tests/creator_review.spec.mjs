import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const inputRoot = path.resolve(process.env.ALE_INPUT_ROOT ?? process.cwd());
const outputRoot = path.resolve(process.env.ALE_OUTPUT_ROOT ?? path.join(inputRoot, "output"));
const reportRoot = path.join(outputRoot, "reports");
const receiptRoot = path.join(outputRoot, "receipts");
const screenshotRoot = path.join(outputRoot, "screenshots");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted && character === '"' && text[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("CSV引号没有闭合");
  if (cell || row.length) {
    row.push(cell);
    if (row.some((value) => value !== "")) rows.push(row);
  }
  const headers = rows.shift() ?? [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvText(headers, rows) {
  return `${headers.join(",")}\n${rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")).join("\n")}\n`;
}

const scenarios = parseCsv(await fs.readFile(path.join(inputRoot, "data", "review_scenarios.csv"), "utf8"))
  .map((row) => ({ ...row, submit_enabled: row.submit_enabled === "true", receipt_data_rows: Number(row.receipt_data_rows) }));
const policy = JSON.parse(await fs.readFile(path.join(inputRoot, "rules", "review_policy.json"), "utf8"));
const storageMatrix = parseCsv(await fs.readFile(path.join(inputRoot, "state", "storage_state_matrix.csv"), "utf8"));
const storageByFile = new Map(storageMatrix.map((row) => [row.state_file, row]));
const results = [];
const externalRequests = [];

async function fillScenario(page, item) {
  await page.getByLabel("案例编号").fill(item.case_id);
  await page.getByLabel("账号状态").selectOption(item.account_status);
  await page.getByLabel("素材类型").selectOption(item.asset_type);
  await page.getByRole("radio", { name: item.commercial_use === "true" ? "是" : "否" }).check();
  await page.getByLabel("披露方式").selectOption(item.disclosure);
  await page.getByLabel("替代文本").fill(item.alt_text);
  await page.getByLabel("排期 UTC").fill(item.schedule_utc);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await fs.mkdir(reportRoot, { recursive: true });
  await fs.mkdir(receiptRoot, { recursive: true });
  await fs.mkdir(screenshotRoot, { recursive: true });
});

for (const item of scenarios) {
  test(`${item.case_id}发布验收`, async ({ browser }) => {
    const stateContract = storageByFile.get(item.storage_state);
    expect(stateContract).toBeTruthy();
    const context = await browser.newContext({
      storageState: path.join(inputRoot, "state", item.storage_state),
      acceptDownloads: true,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.hostname !== "127.0.0.1") externalRequests.push(request.url());
    });
    try {
      await page.goto("/creator_studio.html");
      await expect(page.getByRole("note")).toHaveText(stateContract.expected_banner);
      const form = page.getByRole("form", { name: "素材核验表单" });
      const region = page.getByRole("region", { name: "核验结果" });
      await expect(form).toBeVisible();
      await expect(region).toBeVisible();
      await fillScenario(page, item);
      await page.getByRole("button", { name: "核验素材" }).click();

      const reviewState = page.getByTestId("review-state");
      const status = page.getByRole("status");
      const submit = page.getByRole("button", { name: "提交审核" });
      await expect(reviewState).toHaveText(item.expected_state);
      await expect(status).toHaveText(item.status_text);
      if (item.submit_enabled) await expect(submit).toBeEnabled();
      else await expect(submit).toBeDisabled();

      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "下载当前核验回执" }).click();
      const download = await downloadPromise;
      const expectedFilename = `${item.case_id}_submission_receipt.csv`;
      expect(download.suggestedFilename()).toBe(expectedFilename);
      const receiptPath = `receipts/${expectedFilename}`;
      await download.saveAs(path.join(outputRoot, receiptPath));
      const receiptRows = parseCsv(await fs.readFile(path.join(outputRoot, receiptPath), "utf8"));
      expect(Object.keys(receiptRows[0] ?? {})).toEqual(policy.downloadable_columns);
      expect(receiptRows).toHaveLength(item.receipt_data_rows);
      expect(receiptRows[0]?.review_state).toBe(item.expected_state);

      const namedButtons = (await page.getByRole("button").allTextContents()).map((value) => value.trim()).filter(Boolean);
      expect(namedButtons).toEqual(["核验素材", "提交审核", "下载当前核验回执"]);
      const ariaSnapshot = await page.locator("body").ariaSnapshot();
      expect(ariaSnapshot).toContain("素材核验表单");
      expect(ariaSnapshot).toContain("核验结果");
      const screenshotPath = `screenshots/${item.case_id}.png`;
      await page.screenshot({ path: path.join(outputRoot, screenshotPath), fullPage: true });

      results.push({
        case_id: item.case_id,
        actor_role: stateContract.actor_role,
        account_status: stateContract.account_status,
        expected_banner: stateContract.expected_banner,
        review_state: await reviewState.textContent(),
        submit_enabled: String(await submit.isEnabled()),
        status_text: await status.textContent(),
        receipt_file: receiptPath,
        receipt_rows: receiptRows.length,
        screenshot_file: screenshotPath,
        status_role: await status.getAttribute("role"),
        form_name: "素材核验表单",
        result_region: "核验结果",
        named_buttons: namedButtons.join("|"),
      });
    } finally {
      await context.close();
    }
  });
}

test.afterAll(async () => {
  results.sort((left, right) => left.case_id.localeCompare(right.case_id));
  const headers = [
    "case_id", "actor_role", "account_status", "expected_banner", "review_state", "submit_enabled",
    "status_text", "receipt_file", "receipt_rows", "screenshot_file", "status_role", "form_name",
    "result_region", "named_buttons",
  ];
  await fs.writeFile(path.join(reportRoot, "release_review.csv"), csvText(headers, results));
  expect(results).toHaveLength(scenarios.length);
  expect(results.map((row) => row.case_id)).toEqual(scenarios.map((row) => row.case_id).sort());
  expect(externalRequests).toEqual([]);
});

