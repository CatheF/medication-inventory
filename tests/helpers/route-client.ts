// A thin "HTTP client" over the Next route handlers, for the API tests. Test support only.
//
// It calls the exported GET/POST/PUT/DELETE functions directly (no server), the way tests/helpers/fixtures-extra.ts
// describes. IMPORTANT: a test file that imports this module must mock `@/lib/db` with the fake first, otherwise the real
// Supabase client module throws at import time (it needs environment variables). Example (put it in the test file):
//
//   vi.mock("@/lib/db", async () => {
//     const { supabaseProxy } = await import("../helpers/fake-supabase");
//     return { supabase: supabaseProxy };
//   });
import { DELETE as medicationDelete, GET as medicationGet, PUT as medicationPut } from "@/app/api/medications/[id]/route";
import { GET as barcodeGet } from "@/app/api/medications/barcode/[code]/route";
import { GET as categoriesGet, POST as categoriesPost } from "@/app/api/categories/route";
import { GET as medicationsGet, POST as medicationsPost } from "@/app/api/medications/route";
import { POST as exportXlsxPost } from "@/app/api/order-sheet/xlsx/route";
import { jsonRequest, routeParams } from "./fixtures-extra";

export const api = {
  listCategories: (): Promise<Response> => categoriesGet(),
  createCategory: (name: unknown): Promise<Response> => categoriesPost(jsonRequest("POST", "/api/categories", { name })),

  /** `query` is the raw query string including the "?", e.g. "?category=none&lowStock=true" */
  listItems: (query = ""): Promise<Response> => medicationsGet(jsonRequest("GET", `/api/medications${query}`)),
  createItem: (body: unknown): Promise<Response> => medicationsPost(jsonRequest("POST", "/api/medications", body)),

  getItem: (id: number | string): Promise<Response> =>
    medicationGet(jsonRequest("GET", `/api/medications/${id}`), routeParams({ id: String(id) })),
  updateItem: (id: number | string, body: unknown): Promise<Response> =>
    medicationPut(jsonRequest("PUT", `/api/medications/${id}`, body), routeParams({ id: String(id) })),
  deleteItem: (id: number | string): Promise<Response> =>
    medicationDelete(jsonRequest("DELETE", `/api/medications/${id}`), routeParams({ id: String(id) })),

  /** `code` is the barcode as the route receives it (Next has already URL-decoded it once) */
  lookup: (code: string): Promise<Response> =>
    barcodeGet(jsonRequest("GET", `/api/medications/barcode/${encodeURIComponent(code)}`), routeParams({ code })),

  exportXlsx: (body: unknown): Promise<Response> => exportXlsxPost(jsonRequest("POST", "/api/order-sheet/xlsx", body)),
};
