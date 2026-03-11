import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import Anthropic from "@anthropic-ai/sdk";

export async function GET() {
  try {
    // Current stock for all medications
    const { data: medications, error: medError } = await supabase
      .from("medications")
      .select("id, name, stock, threshold, unit, vendor_url")
      .order("name");

    if (medError) throw medError;

    // Total dispensed per medication in last 30 days
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: dispensed, error: txError } = await supabase
      .from("transactions")
      .select("medication_id, quantity")
      .eq("type", "dispense")
      .gte("created_at", since);

    if (txError) throw txError;

    // Aggregate dispensed quantities per medication
    const dispensedMap = new Map<number, number>();
    for (const tx of dispensed ?? []) {
      dispensedMap.set(tx.medication_id, (dispensedMap.get(tx.medication_id) ?? 0) + tx.quantity);
    }

    const meds = medications ?? [];
    const summary = meds.map((m) => {
      const totalDispensed = dispensedMap.get(m.id) ?? 0;
      const dailyRate = totalDispensed / 30;
      return {
        name: m.name,
        current_stock: m.stock,
        threshold: m.threshold,
        unit: m.unit,
        dispensed_last_30_days: totalDispensed,
        days_of_supply:
          dailyRate > 0 ? Math.round((m.stock / dailyRate) * 10) / 10 : null,
        vendor_url: m.vendor_url,
      };
    });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({
        generated_at: new Date().toISOString(),
        ai_analysis: null,
        data: summary,
        error: "ANTHROPIC_API_KEY not set — add it to .env.local for AI analysis",
      });
    }

    const client = new Anthropic({ apiKey });

    const prompt = `You are a pharmacy inventory assistant for a university health department.
Analyze the following medication inventory data and provide a concise daily reorder report.

Today's date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}

Inventory Data (JSON):
${JSON.stringify(summary, null, 2)}

Please provide:
1. **Urgent Reorders** — items at or below threshold that need immediate action
2. **Reorder Soon** — items with less than 7 days of supply based on usage rate
3. **Watch List** — items dispensed frequently but currently adequate
4. **Summary** — 2-3 sentence overall assessment

Format your response in clear markdown with those four sections. Be specific with quantities and practical with recommendations. If days_of_supply is null, the item has not been dispensed in 30 days.`;

    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const aiText =
      message.content[0].type === "text" ? message.content[0].text : "Unable to generate report";

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      ai_analysis: aiText,
      data: summary,
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to generate report" }, { status: 500 });
  }
}
