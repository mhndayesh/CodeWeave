export async function loginFromUi() {
  return fetch("/api/login", { method: "POST" });
}
