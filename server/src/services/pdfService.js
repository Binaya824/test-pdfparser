import fs from "fs";
import axios from "axios";

import FormData from "form-data";
import { createScheduler, createWorker } from "tesseract.js";

import model from "wink-eng-lite-model";
import winkNLP from "wink-nlp";
// import amqp from "amqplib"
import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'ws';
import os from "os";

class PdfTextExtractor {
    constructor() {
        // this.pdfExtract = new PDFExtract();
        this.scheduler = createScheduler();
        this.nlp = winkNLP(model, ["sbd", "pos"]);
        this.result = {};
        this.clauseEnded = false;
        this.lastClausePage = "";
        this.ClausePages = [];

        this.currentPoint = "";
        this.tableEncountered = false;
        this.clauseStarted = false;
        this.stopExtracting = false;
        this.nonValidatedPoints = [];
        this.isInsideDoubleHash = false
        this.cleanedText = ""
        this.ignoreToken = false


        this.files = []
        this.worker_array = []

    }

    validate(str) {
        return str.match(/^(?:(?:[aA]|[iI])\.|[aAiI]\))/);
    }



    async processFiles(files, ws = '') {

        if (ws != '') {
            ws.on("close", () => {
                this.worker_array.forEach((worker) => {
                    try {
                        worker.terminate();
                        console.log('all worker are terminate.', worker.id)
                    } catch (error) {
                        console.error(error);
                    }
                })
            });
        }


        const nlp = winkNLP(model, ["sbd"]);
        let scheduler = createScheduler()
        const numWorkers = os.cpus().length - 1;

        const workerGen = async () => {
            const worker = await createWorker('eng', 1);
            this.worker_array.push(worker)
            scheduler.addWorker(worker);
        }
        // Initialize workers
        const resArr = Array(numWorkers).fill(null).map(workerGen);
        await Promise.all(resArr);

        // Set up the results structure and other flags
        const result = {};
        let currentPoint = null;
        let tableEncountered = false;
        let clauseStarted = false;
        let stopExtracting = false;
        const nonValidatedPoints = [];
        let progress = 0; // Track the number of files processed

        const trackProgress = (() => {
            const startTime = performance.now()
            let completedJobs = 0
            const totalJobs = files.length
            let processingTime = ''

            return () => {
                completedJobs++
                const progress = (completedJobs / totalJobs) * 100
                console.log(`Progress: ${progress.toFixed(2)}% (${completedJobs}/${totalJobs} jobs completed)`)
                if (ws != '') {
                    ws.send(JSON.stringify({ type: 'progress', message: `Progress: ${progress.toFixed(2)}% (${completedJobs}/${totalJobs} jobs completed)`, progress: progress.toFixed(2), task: { total: totalJobs, completed: completedJobs } }));
                }

                if (completedJobs === totalJobs) {
                    const endTime = performance.now()
                    processingTime = (endTime - startTime) / 1000;
                    processingTime = processingTime / 60
                    // console.log('All Clause extraction jobs completed.', `It took ${processingTime} minute`);
                    if (ws != '') {
                        ws.send(JSON.stringify({ "type": "task_completed", "message": "All Clause extraction jobs completed.", time: processingTime, task: 'clause' }));
                    }

                    // process.exit(0);
                }
            }
        })()

        const chunkSize = 5
        const chunkedFiles = []

        for (let i = 0; i < files.length; i += chunkSize) {
            chunkedFiles.push(files.slice(i, i + chunkSize))
        }
        function restructureObject(parsedTokens) {
            const output = {};
            function setNestedProperty(obj, parentToken, remaingToken, currentKey) {
              console.log("parentToken ------->>>", parentToken, typeof parentToken);
              console.log("currentKey ------->>>", currentKey);
              if (remaingToken.length === 1) {
                obj[parentToken].sub_sequence[remaingToken] = parsedTokens[currentKey];
              } else {
                let i = 2;
                let mObj = obj;
                let nextCurrentKey;
                while (true) {
                  let part = parentToken.slice(i - 2, i);
                  console.log("part ------->>>", part, typeof part);
                  console.log(
                    "remainingTokens ------->>>",
                    remaingToken,
                    typeof remaingToken,
                  );
          
                  if (i === parentToken.length) {
                    break;
                  }
                  // console.log("part", part);
                  mObj = mObj[part].sub_sequence;
          
                  i += 2;
                }
                console.log("mobj", mObj);
                // console.log(
                //   currentKey + remaingToken.pop(),
                //   "currentKey ------->>>",
                //   currentKey,
                // );
                setNestedProperty(
                  mObj,
                  remaingToken[0],
                  remaingToken.slice(-1),
                  currentKey,
                );
              }
            }
            const Toenkeys = Object.keys(parsedTokens);
            Toenkeys.forEach((key, index) => {
              if (key == 0) {
                output["0."] = parsedTokens[key];
              } else {
                const tokenParts = key.split(".").reduce((acc, part) => {
                  if (part) acc.push(part + ".");
                  return acc;
                }, []);
                if (tokenParts.length === 1) {
                  output[tokenParts[0]] = parsedTokens[key];
                } else {
                  const remaingTokens = tokenParts.slice(1, tokenParts.length);
                  const parentToken = tokenParts.slice(0, -1).join("");
          
                  setNestedProperty(output, parentToken, remaingTokens, key);
                }
              }
            });
            console.log("output", JSON.stringify(output, null, 2));
            return output;
          }

        extractLoop:
        for (const chunk of chunkedFiles) {
            if (stopExtracting) break extractLoop;
            const promises = chunk.map(async (file) => {
                const { data: { text } } = await scheduler.addJob('recognize', file);
                progress++;
                trackProgress();
                // console.log({length: text.length})
                return text;
            });

            const texts = await Promise.all(promises);

            texts.forEach((t) => {

                const doc = nlp.readDoc(t);
                const tokens = doc.sentences().out();
                console.log("tokens" , tokens);
                let cleanedText = '';
                let isInsideDoubleHash = false;
                let ignoreToken = false
                let tableString = ""

                tokens.forEach((token) => {
                    const separatedToken = token.split('\n');
                    if (t.match(/Table/) && clauseStarted){
                        console.log("table occured : &&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&7 " , t)
                        for (const ch of chunk) {
                            const regex = /(output\/\d+\/)/;
                            const match = ch.match(regex);
                            console.log("matched : =======>" , match)
                            if (match) {
                                const page = match.input
                                if (!this.ClausePages.includes(page)) {
                                    this.ClausePages.push(page);
                                }
                            }
                        }


                    }
                    
                    if(token.match(/INTRODUCTION/g)){
                        console.log("intro matched ***********")
                        result["0."] = {
                            content: token,
                            sub_sequence: {}
                        }
                        clauseStarted = true;
                        
                    }
                    
                    else if(token.match(/\d+(\.\d+)?\./g) && clauseStarted){
                        const cloggedToken = token.split('\n');
                        const cloggedOutPoint = cloggedToken.pop();
                        const cloggedOutText = cloggedToken.length > 1 ? cloggedToken.slice(0 , cloggedToken.length -1).join("") : "";
                        if(cloggedToken.length > 1){
                            result[currentPoint].content += " " + cloggedOutText.replace(/##.*?##/g , "");
                        }
                        currentPoint = cloggedOutPoint.replace(/##.*?##/g , "");
                    }else{
                        if(result[currentPoint]  && clauseStarted){
                            result[currentPoint].content += " " + token.replace(/##.*?##/g , "")
                        }else if(clauseStarted){
                            result[currentPoint] = {
                                content: token.replace(/##.*?##/g , ""),
                                sub_sequence: {}
                            }
                        }
                    }

                    for(const t of separatedToken){
                        // console.log("separated token :^^^^^^^^^^^^^^^^^^^6" , t)
                        if (
                            t === "**End of Clauses**" ||
                            t === "**End of Clauses™**" || t === "**End of Clauses™*" ||
                            t === "“*End of clauses™" || t === "**¥*% End of clauses ***" || t === "**¥* End of clauses ***"
                        ) {
                            console.log("end occured !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" , t)
                            clauseStarted = false;
                        }
                    }
                    

                    // this.ignoreToken = false
                });

                // if (currentPoint && result[currentPoint]) {
                //     result[currentPoint] limitedText= result[currentPoint].join(" ");
                // }

                // At the end of processing each file:
                if (nonValidatedPoints.length) {
                    this.ClausePages = [];
                    throw new Error(`Validation error, we found some points which are not allowed i.e ${nonValidatedPoints.join(",")}`);
                }

                // for (const key in result) {
                //     result[key] = result[key].trim();
                // }
            });
            console.log("result: " , result)
            // const structuredOutput = restructureObject(result);
            // if (result.hasOwnProperty("1.")) {
            //     // Now, you can also check if the value associated with "1." is "INTRODUCTION"
            //     const ifIntroductionExistsRegex = /INTRODUCTION/g

            //     const ifIntroductionExists = ifIntroductionExistsRegex.test(result["1."])

            //     if (!ifIntroductionExists) {
            //         throw new Error(`Validation error, The first entry should be  '1. INTRODUCTION'`);
            //     } 
            // } else {
            //     throw new Error(`Validation error, the document does not comply with our validation rule.`);
            // }

            // Process each file

            // Process text from each file
            // console.log(this.worker_array,'>>>>>>>>>>>>>>>>>>>>')    

            // this.worker_array.forEach((worker)=>{
            //     try {
            //         worker.terminate();
            //     } catch (error) {
            //         console.error(error);
            //     }
            // })
            if (ws != '') {
                ws.send(JSON.stringify({ type: 'progress_data', data: result }));
            }
            // console.log(`result`, result);
        }

     


        // if (result.hasOwnProperty("0.")) {
        //     // Now, you can also check if the value associated with "1." is "INTRODUCTION"
        //     const ifIntroductionExistsRegex = /INTRODUCTION/g

        //     const ifIntroductionExists = ifIntroductionExistsRegex.test(result["0."])

        //     if (!ifIntroductionExists) {
        //         throw new Error(`Validation error, The first entry should be  '1. INTRODUCTION'`);
        //     }
        // } else {
        //     throw new Error(`Validation error, the document does not comply with our validation rule.`);
        // }

        // Process each file

        // Process text from each file
        // console.log(this.worker_array,'>>>>>>>>>>>>>>>>>>>>')    

        this.worker_array.forEach((worker) => {
            try {
                worker.terminate();
            } catch (error) {
                console.error(error);
            }
        })
        await scheduler.terminate();
        return result
    };

    async extractImagesFromPdf(filePath) {
        // print(filePath,'extract_images')
        console.log(filePath, "extract_images");
        // exportImages("file.pdf", "output/dir")
        //   .then((images) => console.log("Exported", images.length, "images"))
        //   .catch(console.error);
    }
    async extractTableFromPdf(ws = '') {
        const tableData = [];
        try {
            console.log('extract_table_started', "JSONRESPONSE")

            const uuid = uuidv4();
            // await ws.send('Table extraction started.')
            if (ws != '') {
                await ws.send(JSON.stringify({ "type": "new_task_started", "message": "Table extraction started.", task: 'table' }));
            }

            if (this.ClausePages == undefined) {
                this.ClausePages = [];
            }

            const jsonResponse = await sendJsonRequest({ 'tables': this.ClausePages, 'uuid': uuid, 'type': 'extract_table' }, ws);
            this.ClausePages = [];
            console.log(JSON.stringify(jsonResponse , null , 2))
            return jsonResponse;
        } catch (error) {
            console.error("Error:", error);
        }
    }
}



async function sendJsonRequest(request, wsr) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket('ws://py-server:5151');

        ws.on('open', () => {
            console.log('WebSocket connection opened.2');
            // Stringify the JSON request
            const jsonRequest = JSON.stringify(request);
            // console.log(jsonRequest,'-00000')
            // Send the JSON request to the WebSocket server
            ws.send(jsonRequest);
        });

        ws.on('message', (message) => {
            console.log('Received message from WebSocket server:', message);
            // Parse the received JSON response
            const jsonResponse = JSON.parse(message);
            // console.log(`jsonResponse`, jsonResponse);
            // console.log(jsonResponse,'response-from-the-py-server')
            if (jsonResponse.type == 'response') {

                resolve(jsonResponse.response);
                ws.close();
            } else {
                if (wsr != '') {
                    wsr.send(JSON.stringify(jsonResponse))
                    console.log(jsonResponse.message)
                }

            }
            // Resolve the promise with the received JSON response
            // Close the WebSocket connection after receiving a response

        });

        ws.on('close', () => {
            console.log('WebSocket connection closed.');
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error);

            // Reject the promise if there's an error
            reject(error);
        });
    });
}

export default PdfTextExtractor;