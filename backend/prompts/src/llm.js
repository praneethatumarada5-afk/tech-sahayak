'use strict';
/** Single entry point for the AI call (Gemini). */
const config = require('./config');
const gemini = require('./gemini');
const { TutorError } = require('./errors');

const modelName = () => (config.MOCK ? 'MOCK' : config.MODEL);
const generate = (args) => gemini.generate(args);

module.exports = { generate, modelName, TutorError };
