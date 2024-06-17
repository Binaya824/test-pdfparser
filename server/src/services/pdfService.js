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
        let tableIndices = [];
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
            // console.log("texts" , texts)

            texts.forEach((t) => {

                const doc = nlp.readDoc(t);
                const tokens = doc.sentences().out();
                console.log("tokens" , tokens);
                let cleanedText = '';
                let isInsideDoubleHash = false;
                let ignoreToken = false
                let tableEncounteredPoint = ""

                tokens.forEach((token) => {
                    const separatedToken = token.split('\n');
                   

                    for(const t of separatedToken){
                        // console.log("separated token :^^^^^^^^^^^^^^^^^^^6" , t)
                        if (t.match(/TABLE/) && clauseStarted){
                            // tableEncountered = true;
                            tableEncounteredPoint = currentPoint;
                            const elIndex = tableIndices.indexOf(currentPoint);
                            if(elIndex === -1){

                                tableIndices.push(currentPoint);
                            }
                            // console.log("table occured : &&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&7 " , t)
                            for (const ch of chunk) {
                                const regex = /(output\/\d+\/)/;
                                const match = ch.match(regex);
                                // console.log("matched : =======>" , match)
                                if (match) {
                                    const page = match.input
                                    if (!this.ClausePages.includes(page)) {
                                        this.ClausePages.push(page);
                                    }
                                }
                            }
    
    
                        }

                        
                        if(t.match(/INTRODUCTION/g) && currentPoint === "1."){
                            console.log("intro matched ***********")
                            // result[currentPoint] ? null : result[currentPoint] = t;
                            result[currentPoint] = t;
                            // console.log("result : " , result)
                            clauseStarted = true;
                            
                        }
                        else if((
                            t === "**End of Clauses**" ||
                            t === "**End of Clauses™**" || t === "**End of Clauses™*" ||
                            t === "“*End of clauses™" || t === "**¥*% End of clauses ***" || t === "**¥* End of clauses ***" || t === "**End of Clauses™**"
                        )){
                            console.log("end occured #############################################################################################################################")
                            clauseStarted = false;
                            stopExtracting = true;
                        }
                        else if(t.match(/^\d+(\.\d+)*\.$/) ){
                            currentPoint = t;
                        }else {
                            if(result[currentPoint]  && clauseStarted){
                                result[currentPoint]+= " " + t.replace(/##.*?##/g , "")
                            }else if(clauseStarted){
                                result[currentPoint] = t.replace(/##.*?##/g , "")
                            }
                        }
                       
                    }
                     

                });
                
                if (nonValidatedPoints.length) {
                    this.ClausePages = [];
                    throw new Error(`Validation error, we found some points which are not allowed i.e ${nonValidatedPoints.join(",")}`);
                }

               
            });
           
            if (result.hasOwnProperty("1.")) {
                // Now, you can also check if the value associated with "1." is "INTRODUCTION"
                const ifIntroductionExistsRegex = /INTRODUCTION/g

                const ifIntroductionExists = ifIntroductionExistsRegex.test(result["1."])

                if (!ifIntroductionExists) {
                    throw new Error(`Validation error, The first entry should be  '1. INTRODUCTION'`);
                } 
            } else {
                throw new Error(`Validation error, the document does not comply with our validation rule.`);
            }

            // Process each file

            // // Process text from each file
            // console.log(this.worker_array,'>>>>>>>>>>>>>>>>>>>>')    

            // this.worker_array.forEach((worker)=>{
            //     try {
            //         worker.terminate();
            //     } catch (error) {
            //         console.error(error);
            //     }
            // })
            console.log("&&^&^&^&^&^&^^&^&^&^&^&^&^&^&^&^&^&^&^&^&^&^&^&^&^&^&^&^&^ table indices" , tableIndices);
            tableIndices.forEach((index)=> {
            const text = result[index];
            console.log("%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%" , text)
            let indexOfTableKeyword = text.indexOf("TABLE")
                if (indexOfTableKeyword === -1) {
                    indexOfTableKeyword = text.indexOf("(TABLE)");
                }
                console.log("index of table key word ======================================================" , indexOfTableKeyword)
                // const textSeparated = text.split(' ');
                // textSeparated.forEach((el , index)=>{
                //     console.log("element $$$$$$$$$$$$$$$$$" , el)
                // })

                const referLinkIndex = text.indexOf("*")
                console.log("referLinkIndex-------------------------->>>>>>>>>>>>>>>"  , referLinkIndex)
                const referedContent = text.substring(referLinkIndex , text.length);
                console.log("refered content ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~" , referedContent)
                // .concat(' ', referedContent);
                if(referLinkIndex != -1){
                    result[index] = text.substring(0, indexOfTableKeyword + 5).concat(" " , referedContent)
                }else{

                    result[index] = text.substring(0, indexOfTableKeyword + 5)
                }
            })
            console.log("result: " , result)
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