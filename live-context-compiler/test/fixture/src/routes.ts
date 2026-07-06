import { login } from "./auth";
const app = { post: (..._args: unknown[]) => undefined };
app.post("/api/login", () => login("demo@example.com"));
