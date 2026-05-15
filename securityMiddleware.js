export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  next();
}

export function sanitizeInputs(req, res, next) {
  if (req.body && typeof req.body === "object") {
    for (const [key, value] of Object.entries(req.body)) {
      if (typeof value === "string") {
        req.body[key] = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
      }
    }
  }
  next();
}
