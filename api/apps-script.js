const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwgsV2B-36BDdsiKjFtgHYH_ZVyahwelzJCVi2QiLr7VrzaAZa8TpQGJU7yW3IoD_tPHQ/exec";
const UPSTREAM_TIMEOUT_MS = 55000;

function requestBodyAsText(body) {
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  return JSON.stringify(body ?? {});
}

module.exports = async function appsScriptProxy(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).send(JSON.stringify({
      status: "error",
      message: "Method not allowed",
    }));
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const requestUrl = `${APPS_SCRIPT_URL}?_=${Date.now()}`;
    const upstream = await fetch(requestUrl, {
      method: "POST",
      redirect: "follow",
      cache: "no-store",
      headers: {
        "Accept": "application/json",
        "Content-Type": "text/plain;charset=utf-8",
      },
      body: requestBodyAsText(request.body),
      signal: controller.signal,
    });
    const body = await upstream.text();
    return response.status(upstream.status).send(body);
  } catch (error) {
    const message = error && error.name === "AbortError"
      ? "Apps Script ใช้เวลาตอบกลับนานเกินไป"
      : "ไม่สามารถติดต่อ Apps Script ได้";
    return response.status(502).send(JSON.stringify({
      status: "error",
      message,
    }));
  } finally {
    clearTimeout(timeoutId);
  }
};
