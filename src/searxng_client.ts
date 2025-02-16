import axios, { AxiosError, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { promisify } from 'util';
import { exec } from 'child_process';
import * as fs from 'fs'; // Import the 'fs' module
const execAsync = promisify(exec);

const logger = console;

export class SearXNGClient {
    private base_url = "http://localhost:8888/";
    private headers = {
        "X-Searx-API-Key": "f1d2d2f924e986ac86fdf7b36c94bcdf32aa1234567890abcdef1234567890ab",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    };
    private default_engines = ["google", "bing", "duckduckgo", "brave"];
    private num_results = 10;
    private timeout = 10;
    private parsingTimeout = 15;
    private max_content_length = 50000;
    private max_workers = 5;
    private pdfExtractionTimeout = 30;

    async search(query: string, language: string = "en"): Promise<any> {
        const params = {
            "q": query,
            "format": "json",
            "language": language,
            "engines": this.default_engines.join(","),
            "results": this.num_results
        };

        try {
            logger.log(`SearXNGClient: Performing search with query "${query}"`);
            const response = await axios.get(`${this.base_url}/search`, {
                headers: this.headers,
                params,
                timeout: this.timeout * 1000
            });

            logger.log(`SearXNGClient: Search request successful with status ${response.status}`);
            // Log the raw JSON response for debugging
            logger.log(`SearXNGClient: Raw JSON response: ${JSON.stringify(response.data)}`); // ADDED
            return response.data;

        } catch (error: any) {
            let errorMessage = "An unexpected error occurred during the search.";
            if (axios.isAxiosError(error)) {
                const axiosError: AxiosError = error;
                errorMessage = `Axios error during SearXNG search: ${axiosError.message}. Status code: ${axiosError.response?.status || 'N/A'}`;
                if (axiosError.response) {
                    logger.error(`Response data: ${JSON.stringify(axiosError.response.data)}`)
                }
            } else {
                errorMessage = `Non-Axios error during SearXNG search: ${error.message}`;
            }
            logger.error(errorMessage);
            return { results: [] };
        }
    }

    async _fetch_url_content(url: string): Promise<AxiosResponse<any> | null> {
        try {
            logger.log(`SearXNGClient: Fetching content from URL: ${url}`);
            const response = await axios.get(url, {
                headers: this.headers,
                timeout: this.timeout * 1000,
                maxBodyLength: 5 * 1024 * 1024,
                responseType: 'arraybuffer',
            });
            logger.log(`SearXNGClient: Successfully fetched content from ${url}`);
            return response;
        } catch (error: any) {
            let errorMessage = `Error fetching ${url}: An unexpected error occurred.`;

            if (axios.isAxiosError(error)) {
                const axiosError: AxiosError = error;
                errorMessage = `Axios error during content fetch from ${url}: ${axiosError.message}. Status code: ${axiosError.response?.status || 'N/A'}`;
                if (axiosError.response) {
                    logger.error(`Response data: ${JSON.stringify(axiosError.response.data)}`);
                }
            } else {
                errorMessage = `Non-Axios error during content fetch from ${url}: ${error.message}`;
            }
            logger.error(errorMessage);
            return null;
        }
    }

    async _extract_text_from_pdf(url: string, buffer: Buffer): Promise<string | null> {
        try {
            const tempFilePath = `/tmp/temp_${Date.now()}.pdf`;
            await fs.promises.writeFile(tempFilePath, buffer);

            const command = `pdf2txt.py "${tempFilePath}"`;
            logger.log(`Executing: ${command}`);

            const { stdout, stderr } = await Promise.race([
                execAsync(command),
                new Promise<{ stdout: string, stderr: string }>((_, reject) =>
                    setTimeout(() => reject(new Error(`PDF extraction timed out after ${this.pdfExtractionTimeout} seconds`)), this.pdfExtractionTimeout * 1000)
                )
            ]);

            if (stderr) {
                logger.warn(`pdf2txt.py stderr: ${stderr}`);
            }

            await fs.promises.unlink(tempFilePath);

            return stdout.trim();
        } catch (error: any) {
            logger.error(`Error extracting text from PDF ${url}: ${error.message}`);
            return null;
        }
    }

    async _parse_content(response: AxiosResponse<any>, url: string): Promise<{ url: string; content: string } | null> {
        const contentType = response.headers['content-type'] || '';

        if (contentType.includes('application/pdf')) {
            logger.log(`SearXNGClient: Detected PDF content for URL: ${url}`);
            try {
                const pdfText = await this._extract_text_from_pdf(url, Buffer.from(response.data));
                if (pdfText) {
                    return {
                        url: url,
                        content: pdfText.slice(0, this.max_content_length),
                    };
                } else {
                    logger.warn(`SearXNGClient: Could not extract text from PDF: ${url}`);
                    return null;
                }
            } catch (error: any) {
                logger.error(`Error processing PDF ${url}: ${error.message}`);
                return null;
            }
        } else {
            const html = response.data.toString();

            if (!html) {
                logger.warn(`SearXNGClient: No HTML provided for parsing from URL: ${url}`);
                return null;
            }

            try {
                logger.log(`SearXNGClient: Parsing HTML content from URL: ${url}`);

                const parsingPromise = new Promise<{ url: string; content: string } | null>(
                    (resolve, reject) => {
                        try {
                            const dom = new JSDOM(html, { url });
                            const document = dom.window.document;

                            const reader = new Readability(document);
                            const article = reader.parse();

                            let content = article?.textContent;

                            if (!content) {
                                logger.warn(
                                    `SearXNGClient: Readability failed to extract content from ${url}, falling back to Cheerio`,
                                );
                                const $ = cheerio.load(html);
                                $('script, style, nav, footer, header').remove();
                                content = $('body').text().replace(/\s+/g, ' ').trim();
                            }

                            if (!content) {
                                logger.warn(
                                    `SearXNGClient: Cheerio also failed to extract content from ${url}`,
                                );
                                resolve(null);
                            }
                            logger.log(`SearXNGClient: Successfully parsed content from ${url}`);

                            resolve({
                                url: url,
                                content: content.slice(0, this.max_content_length),
                            });
                        } catch (error: any) {
                            logger.error(`Error parsing content from ${url}: ${error.message}`);
                            reject(error);
                        }
                    },
                );

                const timeoutPromise = new Promise<{ url: string; content: string } | null>(
                    (resolve) => {
                        setTimeout(() => {
                            logger.warn(`SearXNGClient: Parsing timed out for URL: ${url}`);
                            resolve(null);
                        }, this.parsingTimeout * 1000);
                    },
                );

                return await Promise.race([parsingPromise, timeoutPromise]);
            } catch (error: any) {
                logger.error(`Error setting up parsing for ${url}: ${error.message}`);
                return null;
            }
        }
    }

    async fetch_and_parse_results(results: any[]): Promise<any[]> {
        if (!results || !Array.isArray(results)) {
            logger.error("SearXNGClient: Invalid results format received. Expected an array.");
            return [];
        }

        const parsedResults: any[] = [];

        for (const result of results) {
            if (!result || typeof result !== 'object') {
                logger.warn("SearXNGClient: Skipping invalid result item: not an object");
                continue;
            }
            const url = result.url;

            if (typeof url !== 'string' || !this._is_valid_url(url)) {
                logger.warn(`SearXNGClient: Skipping result with invalid URL: ${url}`);
                continue;
            }

            try {
                const response = await this._fetch_url_content(url);
                if (response) {
                    const parsedContent = await this._parse_content(response, url);
                    if (parsedContent && parsedContent.content) {
                        parsedResults.push({ ...result, parsed_content: parsedContent.content });
                    }
                }
            } catch (error: any) {
                logger.error(`Error processing result for URL ${url}: ${error.message}`);
            }
        }

        return parsedResults;
    }

    _is_valid_url(url: string): boolean {
        try {
            new URL(url);
            return true;
        } catch (e) {
            return false;
        }
    }

    async search_and_parse(query: string, language: string = "en"): Promise<any[]> {
        try {
            logger.log(`SearXNGClient: Starting search and parse for query "${query}"`);
            const searchResults = await this.search(query, language);

            if (!searchResults || typeof searchResults !== 'object') {  // ADDED CHECK
                logger.error("SearXNGClient: Invalid searchResults format received. Expected an object.");
                return [];
            }

            if (!searchResults.results || !Array.isArray(searchResults.results)) { // ADDED CHECK
                logger.error("SearXNGClient: Invalid searchResults.results format received. Expected an array.");
                return [];
            }

            const results = searchResults.results;
            const parsedResults = await this.fetch_and_parse_results(results);
            logger.log(`SearXNGClient: Successfully completed search and parse for query "${query}"`);
            return parsedResults;
        } catch (error: any) {
            logger.error(`Error during search_and_parse for query "${query}": ${error.message}`);
            return [];
        }
    }
}
