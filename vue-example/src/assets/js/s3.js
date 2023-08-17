class Queue {
    constructor(workerLen) {
        this.workerLen = workerLen ?? 4;         // 同时执行的任务数
        this.list = [];                          // 任务队列
        this.worker = new Array(this.workerLen); // 正在执行的任务
        this.workList = new Array(this.workerLen);//放到work中的元素
    }

    /**
     * 执行一个任务
     * @param { number } index
     * @param { Function } fn: 执行的函数
     * @param { Array<any> } args: 传递给执行函数的参数
     */
    *executionFunc(index, fn, ...args) {
        const _this = this;

        yield fn.call(...args)
            .then(function () {
                // 任务执行完毕后，再次分配任务并执行任务
                _this.worker[index] = undefined;
                _this.workList[index] = undefined;
                _this.run();
            });
    }

    /**
     * 添加到任务队列
     * @param { Array<Array<any>> } list: 任务队列
     */
    addList(list) {
        for (const item of list) {
            this.list.unshift(item);
        }
    }

    // 分配并执行任务
    run() {
        const runIndex = [];
        for (let i = 0; i < this.workerLen; i++) {
            const len = this.list.length;
            if (!this.worker[i] && len > 0) {
                //添加元素进workList
                this.workList[i] = this.list[len - 1][3];
                // 需要执行的任务
                this.worker[i] = this.executionFunc(i, ...this.list[len - 1]);
                runIndex.push(i);
                // 从任务队列内删除任务
                this.list.pop();
            }
        }

        // 执行任务
        for (const index of runIndex) {
            this.worker[index].next();
        }
    }
}

const {
    S3Client,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    ListMultipartUploadsCommand,//bucket中正在上传的文件列表
    ListPartsCommand,//列出文件已上传的分片
    GetObjectCommand,//获取文件
} = require("@aws-sdk/client-s3");
import SparkMD5 from "./spark-md5.min.js";


const queue = new Queue();//添加文件的队列

let s3 = null;

// 初始化s3客户端
export function init({
                         endpoint,
                         region,
                         s3ForcePathStyle = true,
                         signatureVersion,
                         forcePathStyle = true,
                         credentials,
                     }) {
    if (endpoint === undefined || region === undefined || signatureVersion === undefined || credentials.accessKeyId === undefined || credentials.secretAccessKey === undefined) {
        return console.log("s3客户端初始化失败，请检查是否参数填写完整");
    }
    s3 = new S3Client({
        endpoint: endpoint,
        region: region,
        s3ForcePathStyle: s3ForcePathStyle,
        signatureVersion: signatureVersion,
        forcePathStyle: forcePathStyle,
        credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey
        }
    });
}

//取消文件上传
export async function cancel({ bucket, fKey }) {
    if (bucket === undefined || fKey === undefined) {
        console.log("取消文件失败，请检查事件参数是否填写完整")
        return false;
    }
    //查询是否还有其它连接
    const listUploads = await listMultipartUploadsCommand({ bucket: bucket, key: fKey });
    if (listUploads.Uploads !== undefined && listUploads.Uploads.length > 0) {
        const uploads = listUploads.Uploads;
        for (const one in uploads) {
            let uploadOne = uploads[one];
            const uploadId = uploadOne.UploadId;//UploadId
            const key = uploadOne.Key;//key
            //取消事件
            let result = await abortMultipartUpload({ bucket: bucket, key: key, uploadId: uploadId });
            if(result === 'err'){
                return false;
            }
        }
    }
    return true;
}
//获取任务队列是否有该文件的上传任务
export function getWorker(key) {
    const list = queue.list;
    const worklist = queue.workList;
    for (const l in list) {
        let f = list[l][3];
        if (f.key === key) {
            return true;
        }
    }
    for (const w in worklist) {
        if (worklist[w] !== undefined && worklist[w].key === key) {
            return true;
        }
    }
    return false;
}


//上传文件操作 将文件加入到队列
export async function fileChange({ fileList, bucket, changeStatus, getSuspend, changeSharding }) {
    if (fileList === undefined || bucket === undefined || changeSharding === undefined || changeStatus === undefined || getSuspend === undefined) {
        return console.log("上传文件失败，请检查参数是否填写完整")
    }
    if (s3 === null) {
        return console.log("未创建s3客户端，请先调用init事件");
    }
    for (let i = 0; i < fileList.length; i++) {
        let fileInformation = fileList[i];
        queue.addList([[exist, undefined, bucket, fileInformation, changeStatus, getSuspend, changeSharding]]);
    }
    queue.run();
}

//查询文件是否存在于bucket或者正在上传
async function exist(bucket, fileInformation, changeStatus, getSuspend, changeSharding) {
    // 1、查询该文件是否已上传到bucket
    let needSuspend = getSuspend(fileInformation.key);//判断前端是否暂停了该文件上传
    if (needSuspend === false) {//不需要暂停
        //判断sharding里面是否有东西，有东西证明已经上传过分片了，不需要再进行检测
        if (fileInformation.sharding.length === 0) {
            let existBucket = await existInBucket({ bucket, fileInformation: fileInformation });
            console.log("existBucket", existBucket)
            if (existBucket === 'true') {
                changeStatus(fileInformation.key, 'success');//直接告诉前端，状态
                return;
            } else if (existBucket === 'same key') {
                console.log(fileInformation.key + "  bucket中存在同名不同内容的文件");
            } else if (existBucket === 'not exist') {
                console.log(fileInformation.key + "  bucket中不存在该文件");
            }
            needSuspend = getSuspend(fileInformation.key);//再次判断前端是否暂停了该文件上传
            if (needSuspend === false) {
                //2、查询该文件是否存在上传事件
                let upload = await existUpload({ bucket: bucket, fileInformation: fileInformation });
                if (upload.code === 0) {
                    //存在该上传事件并且已经上传了多个分片
                    console.log(fileInformation.key + "  存在上传事件，并已经上传多个分片");
                    //将分片存入sharding
                    const uploadId = upload.uploadId;
                    let parts = upload.parts;
                    for (let i = 0; i < parts.length; i++) {
                        fileInformation.sharding.push({ ETag: parts[i].ETag, PartNumber: parts[i].PartNumber, Size: parts[i].Size, UploadId: uploadId });
                    }
                    changeSharding(fileInformation.key, fileInformation.sharding);//告诉前端，加入分片
                    //重新上传
                    await uploadFile({ fileInformation: fileInformation, uploadId: uploadId, bucket, changeStatus, getSuspend, changeSharding });
                } else if (upload.code === 1) {
                    // //重名但是不同文件
                    console.log('err 重名文件')
                    changeStatus(fileInformation.key, 'same key');
                } else if (upload.code === 2) {
                    //没有上传事件
                    console.log(fileInformation.key + "  不存在上传事件");
                    //建立分段上传事件
                    const connect = await createMultipartUpload({ bucket: bucket, key: fileInformation.key, type: fileInformation.file.type });
                    //上传整个文件
                    await uploadFile({ fileInformation: fileInformation, uploadId: connect.UploadId, bucket: bucket, changeStatus, getSuspend, changeSharding });
                }
            } else {
                return;
            }
        } else {
            //分片组里面有东西
            //重新上传
            await uploadFile({ fileInformation: fileInformation, uploadId: fileInformation.sharding[0].UploadId, bucket, changeStatus, getSuspend, changeSharding });
        }
    } else {
        return;
    }
}

//上传文件未上传的所有分片
async function uploadFile({ fileInformation, uploadId, bucket, changeStatus, getSuspend, changeSharding }) {//   file:上传文件,   uploadId  parts:已上传的分片
    const chunkCount = Math.ceil(fileInformation.file.size / fileInformation.shardSize)//总分片数
    //循环切片并上传
    for (let i = 0; i < chunkCount; i++) {
        let needSuspend = getSuspend(fileInformation.key);//获取前端暂停状态
        if (needSuspend === false) {   //在不需要暂停的情况下使用
            let start = i * fileInformation.shardSize;//文件分片开始位置
            let end = Math.min(fileInformation.file.size, start + fileInformation.shardSize)//文件分片结束位置
            let _chunkFile = fileInformation.file.slice(start, end);//切片文件 即 待上传文件分片
            //判断parts中是否存在该分片
            let res1 = fileInformation.sharding.filter((part) => {
                return part.PartNumber === (i + 1);
            });
            if (res1.length === 0) {
                //不包含该分片
                const upload = await uploadPart({ f: _chunkFile, uploadId: uploadId, key: fileInformation.key, bucket: bucket, num: i + 1 });//将分片上传
                //判断sharding中是否存在该分片，如果不存在的话，才判错
                let res2 = fileInformation.sharding.filter((part) => {
                    return part.PartNumber === (i + 1);
                });
                if (res2.length === 0) {
                    if (upload !== 'err') {//上传分片成功，并且没有暂停上传
                        //判断是否存在该分片
                        //判断parts中是否存在该分片
                        let res3 = fileInformation.sharding.filter((part) => {
                            return part.PartNumber === (i + 1);
                        });
                        if (res3.length === 0) {
                            fileInformation.sharding.push({ ETag: upload.ETag, PartNumber: i + 1, Size: _chunkFile.size, UploadId: uploadId });//上传成功，存到sharding
                            changeSharding(fileInformation.key, fileInformation.sharding);
                        }
                    } else if (upload === 'err') {
                        changeStatus(fileInformation.key, 'err');
                        return;
                    }
                }

            }
        } else {
            return;
        }
    }//for
    if (fileInformation.sharding.length === chunkCount) {
        //合并分片
        const complete = await completeMultipartUpload({ bucket: bucket, key: fileInformation.key, sharding: fileInformation.sharding, uploadId: uploadId });
        if (complete !== 'err') {
            changeStatus(fileInformation.key, 'success');//通知前端，上传成功
        } else {
            changeStatus(fileInformation.key, 'err');//通知前端，上传失败
        }

    }
}

// 判断该文件是否已经存在于bucket
// bucket   file:上传文件
// 返回值  'same key':同名不同文件 'not exist':不存在该文件  'true':该文件已存在bucket中
async function existInBucket({ bucket, fileInformation }) {
    if (s3 === null) {
        return console.log("未创建s3客户端，请先调用init事件");
    }
    //getObject 每次最多传回767448b的数据，所以要分段请求
    let bucketFileUniArray = [];
    // 分段
    let count = Math.ceil(fileInformation.file.size / 767448);
    if (count > 4) {
        count = 4;
    }
    for (let i = 0; i < count; i++) {
        const obj = await getObject({ bucket: bucket, fileInformation: fileInformation, count: i });
        if (obj !== 'err') {
            //获取文件的文件体 计算某个分片的md5
            const fileBody = obj.Body;
            let fileUnitArray = await fileBody.transformToByteArray();
            bucketFileUniArray = [...bucketFileUniArray, ...fileUnitArray];
        } else {
            return 'not exist';
        }
    }
    let bucketFileBufferArray = new Uint8Array(bucketFileUniArray);
    console.log("bucketFileBufferArray.buffer", bucketFileBufferArray.buffer)
    // 将传入文件的fileReader 转成  arrayBuffer
    let fileArrayBuff = null;
    fileArrayBuff = await new Promise((resolve) => {
        let fileReader = new FileReader();
        fileReader.readAsArrayBuffer(fileInformation.file.slice(0, count * 767448));
        fileReader.onload = (e) => {
            resolve(e.target.result);
        };
    });
    if (fileArrayBuff.byteLength > count * 767448) {
        fileArrayBuff = fileArrayBuff.slice(0, count * 767448);
    }
    let bodyMD5 = await getMD5({ arrayBuffer: bucketFileBufferArray.buffer });
    let fileMD5 = await getMD5({ arrayBuffer: fileArrayBuff });
    if (bodyMD5 === fileMD5) {
        //证明是同一个文件 秒传
        return 'true';
    } else {
        return 'same key';
    }
}

//判断该文件是否正在上传
// bucket:bucket   file:上传文件
//返回值 'not exist upload':不存在上传事件  'same key':同名不同文件
async function existUpload({ bucket, fileInformation }) {
    //判断该文件是否有上传事件
    const listUploads = await listMultipartUploadsCommand({ bucket: bucket, key: fileInformation.key });
    if (listUploads !== 'err') {
        if (listUploads.Uploads !== undefined && listUploads.Uploads.length > 0) {
            //存在上传事件 获取上传的第一个分片的eTag，计算传入文件md5，相比较是否相同
            const uploads = listUploads.Uploads;
            for (const one in uploads) {//可能存在多个连接
                let uploadOne = uploads[one];
                const uploadId = uploadOne.UploadId;//UploadId
                const key = uploadOne.Key;//key
                //查询该文件已上传分片
                const listParts = await listPartsCommand({ bucket: bucket, key: key, uploadId: uploadId });
                if (listParts !== 'err') {
                    if (listParts.Parts !== undefined && listParts.Parts.length !== 0) {
                        //存在分片
                        let etag = listParts.Parts[0].ETag;
                        //计算文件的第一个分片的md5
                        let fileSlice = null;
                        if (fileInformation.file.size > fileInformation.shardSize) {
                            fileSlice = fileInformation.file.slice(0, fileInformation.shardSize);
                        } else {
                            fileSlice = fileInformation.file;
                        }
                        let fileMD5 = await new Promise((resolve) => {
                            const fileReader = new FileReader();
                            var spark = new SparkMD5.ArrayBuffer();
                            fileReader.readAsArrayBuffer(fileSlice);
                            fileReader.onload = (e) => {
                                spark.append(e.target.result);
                                var m = spark.end();
                                resolve(m);
                            };
                        });
                        if (etag.split('"')[1] === fileMD5) {
                            //是同一个文件上传
                            return {
                                code: 0,
                                message: 'true',
                                uploadId: uploadId,
                                key: key,
                                parts: listParts.Parts
                            }
                        } else {
                            //同名不同文件
                            continue;
                        }
                    } else {
                        //该文件有进行上传，但没有上传完成一个分片
                        continue;
                    }
                } else {
                    //有连接，没上传分片
                    continue;
                }
            }//for
            return {
                code: 1,
                message: 'same key'
            }
        } else {
            //无连接
            return {
                code: 2,
                message: 'not exist upload'
            };
        }
    } else {
        //无连接
        return {
            code: 2,
            message: 'not exist upload'
        };
    }
}

//计算arrayBuffer的md5值
async function getMD5({ arrayBuffer }) {
    console.log("arrayBuffer", arrayBuffer)
    return await new Promise((resolve) => {
        const spark = new SparkMD5.ArrayBuffer();
        spark.append(arrayBuffer);
        const m = spark.end();
        resolve(m);
    });
}

//建立文件上传事件
async function createMultipartUpload({ bucket, key, type }) {//bucket:bucket  key:文件名 type：文件类型
    if (s3 === null) {
        return console.log("未创建s3客户端，请先调用init事件");
    }
    const params = {
        Bucket: bucket,
        Key: key,
        ContentType: type
    };
    const res = async () => {
        try {
            return await s3.send(new CreateMultipartUploadCommand(params));
        } catch (err) {
            console.log('建立上传事件失败：', err.message)
            return 'err';
        }
    }
    return res();
}

//上传一个分片
async function uploadPart({ f, uploadId, key, bucket, num }) { //f:文件分片，num：分片标号
    if (s3 === null) {
        return console.log("未创建s3客户端，请先调用init事件");
    }
    const params = {
        Bucket: bucket,
        Key: key,
        PartNumber: num,
        UploadId: uploadId,
        Body: f
    };
    const res = async () => {
        try {
            return await s3.send(new UploadPartCommand(params));
        } catch (err) {
            console.log('上传分片第 ' + num + ' 片错误信息', err.message)
            return 'err';
        }
    }
    return res();
}
//将分片合并
async function completeMultipartUpload({ bucket, key, sharding, uploadId }) {
    if (s3 === null) {
        return console.log("未创建s3客户端，请先调用init事件");
    }
    let parts = [];
    for (let i = 0; i < sharding.length; i++) {
        parts.push({
            "ETag": sharding[i].ETag,
            "PartNumber": sharding[i].PartNumber,
        })
    }
    const params = {
        Bucket: bucket,
        Key: key,
        MultipartUpload: {
            Parts: parts
        },
        UploadId: uploadId
    };
    const res = async () => {
        try {
            return await s3.send(new CompleteMultipartUploadCommand(params))
        } catch (err) {
            console.log("合并分片失败: ", err.message);
            return 'err';
        }
    }
    return res();
}

//查询某个文件已经上传的所有分片
async function listPartsCommand({ bucket, key, uploadId }) {
    if (s3 === null) {
        return console.log("未创建s3客户端，请先调用init事件");
    }
    const params = {
        Bucket: bucket,
        Key: key,
        UploadId: uploadId
    };
    const res = async () => {
        try {
            return await s3.send(new ListPartsCommand(params));
        } catch (err) {
            console.log("查询该文件已上传分片失败: " + err.message);
            return 'err';
        }
    }
    return res();
}
//查询该文件是否存在上传事件
async function listMultipartUploadsCommand({ bucket, key }) {
    if (s3 === null) {
        return console.log("未创建s3客户端，请先调用init事件");
    }
    const params = {
        Bucket: bucket,
        Delimiter: '',
        MaxUploads: 1000,
        Prefix: key
    };
    const res = async () => {
        try {
            return await s3.send(new ListMultipartUploadsCommand(params));
        } catch (err) {
            console.log("查询 " + key + " 文件是否存在上传事件失败: " + err.message);
            return 'err';
        }
    }
    return res();
}
//取消上传事件
async function abortMultipartUpload({ bucket, key, uploadId }) {
    if (s3 === null) {
        return console.log("未创建s3客户端，请先调用init事件");
    }
    const params = {
        Bucket: bucket,
        Key: key,
        UploadId: uploadId
    };
    const res = async () => {
        try {
            return await s3.send(new AbortMultipartUploadCommand(params))
        } catch (err) {
            console.log("取消 " + key + " 文件连接失败: " + err.message);
            return 'err';
        }
    }
    return res();
}
//获取文件
async function getObject({ bucket, fileInformation, count }) {
    //一次请求最多 767448
    if (s3 === null) {
        return console.log("未创建s3客户端，请先调用init事件");
    }
    let byte1 = ((count + 1) * 767448 - 1) > fileInformation.file.size ? fileInformation.file.size : ((count + 1) * 767448 - 1);
    let byte2 = (count * 767448) > fileInformation.file.size ? fileInformation.file.size : (count * 767448);
    let range = "bytes=" + byte2 + "-" + byte1;
    const params = {
        Bucket: bucket,
        Key: fileInformation.key,
        Range: range
    };
    const res = async () => {
        try {
            return await s3.send(new GetObjectCommand(params));
        } catch (err) {
            console.log('获取 ' + fileInformation.key + ' 文件失败：', err.message);
            return 'err';
        }
    }
    return res();
}

