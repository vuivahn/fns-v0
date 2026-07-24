"use strict";

const js = require("@eslint/js");

module.exports = [
  {
    ignores: ["coverage/**", ".nyc_output/**", "node_modules/**"]
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        Buffer: "readonly",
        console: "readonly",
        module: "readonly",
        __dirname: "readonly",
        process: "readonly",
        require: "readonly",
        setImmediate: "readonly"
      }
    }
  }
];
