export class ProviderHTTPError extends Error {
    constructor(status, detail, label) {
        const prefix = label ? `${label} ` : '';
        super(`${prefix}API request failed (${status}): ${detail}`);
        this.status = status;
    }
}

export class InvalidResponseError extends Error {
    constructor(detail) {
        super(detail || 'Invalid API response format');
    }
}
