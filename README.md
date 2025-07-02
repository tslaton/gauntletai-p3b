# Configuration

You need to set your OpenAI key in the settings before the file wranger can run.

You also should configure the folder it watches for `.pdf`s to your liking.

# Usage

The intended use is you can leave this app running and process pdfs as from email or scanners as they come in.

You can also drag and drop any files you want processed.

Your badly-named pdfs will be automatically renamed like: `yyyy-mm-dd ${title} [${addressee}].pdf` and optionally, lower-cased.

eg., `scan0001.pdf` -> `2025-07-01 pacifc gas and electric bill details [trevor].pdf`

# Development

This program is developed using [Electron](https://www.electronjs.org/).

To start the development server:

```bash
npm install
npm start
```

# Rationale

See [Possible problem spaces](./_docs/presearch/product/Possible problem spaces.md)
