export class GeminiError extends Error {
    constructor(errorType, message) {
        super(message);
        this.errorType = errorType;
    }
}
