import fs from 'node:fs';
import path from 'node:path';
import PDFParser from 'pdf2json';
import MacOCR from '@cherrystudio/mac-system-ocr';
import OpenAI from 'openai';
import { pdfToPng } from 'pdf-to-png-converter';

interface PDFMetadata {
  date: string;
  title: string;
  addressee: string;
}

interface ProcessingState {
  path: string;
  rawText: string | null;
  meta: PDFMetadata | null;
  status: 'parsing' | 'extracting' | 'renaming' | 'completed' | 'error';
  error?: string;
}

export class PDFProcessor {
  private openai: OpenAI | null = null;
  
  constructor(private apiKey: string, private model: string = 'gpt-3.5-turbo') {
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
    }
  }
  
  updateConfig(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
    } else {
      this.openai = null;
    }
  }
  
  async processPDF(filePath: string, onUpdate?: (state: ProcessingState) => void): Promise<void> {
    const state: ProcessingState = {
      path: filePath,
      rawText: null,
      meta: null,
      status: 'parsing'
    };
    
    try {
      // Update status
      onUpdate?.(state);
      
      // Parse PDF
      const text = await this.parsePDF(filePath);
      state.rawText = text;
      
      // Extract metadata using LLM
      state.status = 'extracting';
      onUpdate?.(state);
      
      if (!this.openai) {
        throw new Error('OpenAI API key not configured');
      }
      
      const metadata = await this.extractMetadata(text);
      state.meta = metadata;
      
      // Rename file
      state.status = 'renaming';
      onUpdate?.(state);
      
      await this.renameFile(filePath, metadata);
      
      state.status = 'completed';
      onUpdate?.(state);
      
    } catch (error) {
      state.status = 'error';
      state.error = error instanceof Error ? error.message : 'Unknown error';
      onUpdate?.(state);
      throw error;
    }
  }
  
  private async parsePDF(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const pdfParser = new PDFParser();
      
      pdfParser.on('pdfParser_dataError', (errData: any) => {
        reject(errData.parserError);
      });
      
      pdfParser.on('pdfParser_dataReady', async (pdfData: any) => {
        let text = '';
        
        // Extract text from PDF data
        if (pdfData.Pages) {
          for (const page of pdfData.Pages) {
            if (page.Texts) {
              for (const textItem of page.Texts) {
                if (textItem.R) {
                  for (const r of textItem.R) {
                    if (r.T) {
                      text += decodeURIComponent(r.T) + ' ';
                    }
                  }
                }
              }
              text += '\n\n';
            }
          }
        }
        
        // If extracted text is too short, try OCR
        if (text.trim().length < 20) {
          try {
            text = await this.ocrPDF(filePath);
          } catch (ocrError) {
            console.error('OCR failed:', ocrError);
            // Return whatever text we got from pdf2json
          }
        }
        
        resolve(text);
      });
      
      pdfParser.loadPDF(filePath);
    });
  }
  
  private async ocrPDF(filePath: string): Promise<string> {
    try {
      // Convert PDF pages to PNG images
      const pages = await pdfToPng(filePath, {
        disableFontFace: true,
        useSystemFonts: true,
        viewportScale: 2.0, // Higher quality for better OCR
      });
      
      const ocrResults: string[] = [];
      
      // Process each page with OCR
      for (const page of pages) {
        try {
          // Create a temporary file for the PNG
          const tempPath = path.join(path.dirname(filePath), `temp_ocr_${Date.now()}_${page.pageNumber}.png`);
          await fs.promises.writeFile(tempPath, page.content);
          
          // Perform OCR on the image
          const result = await MacOCR.recognizeFromPath(tempPath);
          ocrResults.push(result.text);
          
          // Clean up temp file
          await fs.promises.unlink(tempPath).catch(() => {});
        } catch (pageError) {
          console.error(`OCR error on page ${page.pageNumber}:`, pageError);
        }
      }
      
      return ocrResults.join('\n\n');
    } catch (error) {
      console.error('OCR error:', error);
      throw error;
    }
  }
  
  private async extractMetadata(text: string): Promise<PDFMetadata> {
    if (!this.openai) {
      throw new Error('OpenAI client not initialized');
    }
    
    const systemPrompt = `You are a parser that extracts three fields from documents:
- date (yyyy-mm-dd; today if absent)
- title (<= 8 words, no commas)
- addressee (first name only; blank if unknown)
Return JSON exactly like {"date":"...", "title":"...", "addressee":"..."}`;
    
    const userPrompt = `Document text follows \`\`\`
${text.slice(0, 12000)}
\`\`\``;
    
    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0,
    });
    
    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No content returned from LLM');
    }
    
    try {
      const metadata = JSON.parse(content.trim());
      
      // Ensure we have valid data
      return {
        date: metadata.date || new Date().toISOString().split('T')[0],
        title: (metadata.title || 'Untitled').slice(0, 100),
        addressee: (metadata.addressee || 'Unknown').slice(0, 50)
      };
    } catch (parseError) {
      console.error('Failed to parse LLM response:', content);
      throw new Error('Invalid JSON from LLM');
    }
  }
  
  private async renameFile(filePath: string, metadata: PDFMetadata): Promise<string> {
    const dir = path.dirname(filePath);
    const newName = `${metadata.date} ${metadata.title} [${metadata.addressee}].pdf`;
    
    // Clean filename for filesystem
    const cleanName = newName.replace(/[<>:"/\\|?*]/g, '-');
    const newPath = path.join(dir, cleanName);
    
    // Check if file already exists
    if (fs.existsSync(newPath) && newPath !== filePath) {
      // Add a number suffix
      let counter = 1;
      let finalPath = newPath;
      while (fs.existsSync(finalPath)) {
        const base = path.basename(newPath, '.pdf');
        finalPath = path.join(dir, `${base} (${counter}).pdf`);
        counter++;
      }
      await fs.promises.rename(filePath, finalPath);
      return finalPath;
    }
    
    await fs.promises.rename(filePath, newPath);
    return newPath;
  }
}