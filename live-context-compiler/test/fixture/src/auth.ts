export function findUser(email: string) {
  return { id: "u1", email, status: "active" };
}

export function createSession(userId: string) {
  return { token: `session:${userId}` };
}

export function login(email: string) {
  const user = findUser(email);
  if (user.status !== "active") throw new Error("blocked");
  return createSession(user.id);
}
