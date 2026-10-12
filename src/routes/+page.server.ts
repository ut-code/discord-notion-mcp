import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => ({ mcpUrl: locals.deps.mcpUrl });
