'use strict';
class TutorError extends Error {
  constructor(code, message) { super(message); this.name = 'TutorError'; this.code = code; }
}
module.exports = { TutorError };
