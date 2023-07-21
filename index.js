class Queue {
    constructor(workerLen) {
        this.workerLen = workerLen ?? 4;         // 同时执行的任务数
        this.list = [];                          // 任务队列
        this.worker = new Array(this.workerLen); // 正在执行的任务
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


let chunkSize = 32 * 1024 * 1024;//定义分片的大小 为32M  采用分片上传时，只能并且只有有最后一个分片的size 小于 指定值（默认5M），不然就会报错
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
import SparkMD5 from "/spark-md5.min.js";


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
    fragmentationSize = 32
}) {
    if (fragmentationSize < 5) {
        return console.log("分片大小不能小于5M,请输入大于5的数字");
    }
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
    if (fragmentationSize != null) {
        chunkSize = fragmentationSize * 1024 * 1024;
    }
}

//取消文件上传
export async function cancel({ bucket, file }) {
    if(bucket == undefined || file == undefined){
        return console.log("取消文件失败，请检查事件参数是否填写完整");
    }
    //查询是否还有其它连接
    const listUploads = await listMultipartUploadsCommand({ bucket: bucket, name: file.name });
    if (listUploads.Uploads != undefined && listUploads.Uploads.length > 0) {
        const uploads = listUploads.Uploads;
        for (const one in uploads) {
            let uploadOne = uploads[one];
            const uploadId = uploadOne.UploadId;//UploadId
            const key = uploadOne.Key;//key
            //取消事件
            await abortMultipartUpload({ bucket: bucket, key: key, uploadId: uploadId });
        }
    }
}

//上传文件操作 将文件加入到队列
export async function fileChange({ files, bucket, changePercentage, changeStatus, getSuspend }) {
    if(files == undefined || bucket == undefined || changePercentage == undefined|| changeStatus == undefined || getSuspend == undefined){
        return console.log("上传文件失败，请检查参数是否填写完整")
    }
    if (s3 === null) {
        return console.log("未创建s3客户端，请先调用init事件");
    }
    for (let i = 0; i < files.length; i++) {
        let file = files[i];
        queue.addList([[exist, undefined, bucket, file, changePercentage, changeStatus, getSuspend]]);
    }
    queue.run();
}

//查询文件是否存在于bucket或者正在上传
async function exist(bucket, file, changePercentage, changeStatus, getSuspend) {
    // 1、查询该文件是否已上传到bucket
    let needSuspend = getSuspend(file);//判断前端是否暂停了该文件上传
    if (needSuspend === false) {
        let existBucket = await existInBucket({ bucket, file });
        if (existBucket === 'true') {
            console.log(file.name + "  bucket中已存在该文件");
            changePercentage(file, 100);
            changeStatus(file, 'success');
            return;
        } else if (existBucket === 'same name') {
            console.log(file.name + "  bucket中存在同名不同内容的文件");
        } else if (existBucket === 'not exist') {
            console.log(file.name + "  bucket中不存在该文件");
        }
        needSuspend = getSuspend(file);//再次判断前端是否暂停了该文件上传
        if (needSuspend === false) {
            //2、查询该文件是否存在上传事件
            let upload = await existUpload({ bucket: bucket, file: file });
            // console.log(upload);
            if (upload.code === 0) {
                //存在该上传事件并且已经上传了多个分片
                console.log(file.name + "  存在上传事件，并已经上传多个分片");
                const uploadId = upload.uploadId;
                let parts = upload.parts;
                //重新上传
                const chunkCount = Math.ceil(file.size / chunkSize)//总分片数
                let percentage = Math.min(99, ((Math.max(parts.length / chunkCount, 0.001)) * 100).toFixed(1));//改变进度条
                changePercentage(file, Math.round(percentage));
                //将该文件未上传的分片上传上去
                await uploadFile({ file: file, uploadId: uploadId, parts: parts, bucket, beginPercentage: Math.round(percentage), changePercentage, changeStatus, getSuspend });
            } else if (upload.code === 1) {
                // //重名但是不同文件
                console.log('err 重名文件')
                changeStatus(file, 'same name');
                // getStatus('same name', file.name);
            } else if (upload.code === 2) {
                //没有上传事件
                console.log(file.name + "  不存在上传事件");
                //建立分段上传事件
                const connect = await createMultipartUpload({ bucket: bucket, key: file.name, type: file.type });
                //上传整个文件
                await uploadFile({ file: file, uploadId: connect.UploadId, parts: [], bucket: bucket, beginPercentage: 0, changePercentage, changeStatus, getSuspend });
            }
        } else {
            changeStatus(file, 'suspend');//通知前端，暂停了
        }
    } else {
        changeStatus(file, 'suspend');//通知前端，暂停了
    }
}

//上传文件未上传的所有分片
async function uploadFile({ file, uploadId, parts, bucket, beginPercentage, changePercentage, changeStatus, getSuspend }) {//   file:上传文件,   uploadId  parts:已上传的分片
    let sharding = [];//成功分片信息
    const chunkCount = Math.ceil(file.size / chunkSize)//总分片数
    //循环切片并上传
    for (let i = 0; i < chunkCount; i++) {
        let needSuspend = getSuspend(file);//获取前端暂停状态
        if (needSuspend === false) {   //在不需要暂停的情况下使用
            let start = i * chunkSize;//文件分片开始位置
            let end = Math.min(file.size, start + chunkSize)//文件分片结束位置
            let _chunkFile = file.slice(start, end);//切片文件 即 待上传文件分片
            //判断parts中是否存在该分片
            let res = parts.filter((part) => {
                return part.PartNumber === (i + 1);
            });
            if (res.length === 0) {
                //不包含该分片
                const upload = await uploadPart({ f: _chunkFile, uploadId: uploadId, key: file.name, bucket: bucket, num: i + 1 });//将分片上传
                if (upload != 'err') {//上传分片成功，并且没有暂停上传
                    //判断sharding中是否存在该分片
                    let res1 = sharding.filter((shard) => {
                        return shard.PartNumber === (i + 1);
                    });
                    if (res1.length === 0) {
                        sharding.push({ ETag: upload.ETag, PartNumber: i + 1 });//上传成功，存到sharding
                    }
                    let percentage = Math.max(beginPercentage, Math.min(99, (((i + 1) / chunkCount) * 100).toFixed(1)));//改变进度条
                    changePercentage(file, percentage);
                } else if (upload === 'err') {
                    changeStatus(file, 'err')
                    return;
                }
            } else {
                //包含该分片
                //判断sharding中是否存在该分片
                let res1 = sharding.filter((shard) => {
                    return shard.PartNumber === (i + 1);
                });
                if (res1.length === 0) {
                    sharding.push({ ETag: res[0].ETag, PartNumber: res[0].PartNumber });//不发送请求，直接存到sharding
                }
                let percentage = Math.max(beginPercentage, Math.min(99, (((i + 1) / chunkCount) * 100).toFixed(1)));//改变进度条
                changePercentage(file, percentage);
            }
        } else {
            changeStatus(file, 'suspend');//通知前端，暂停了
            return;
        }
    }//for
    if (sharding.length === chunkCount) {
        //合并分片
        const complete = await completeMultipartUpload({ bucket: bucket, key: file.name, parts: sharding, uploadId: uploadId });
        if (complete != 'err') {
            changePercentage(file, 100);//通知前端，进度条改变
            changeStatus(file, 'success');//通知前端，上传成功
        } else {
            changeStatus(file, 'err');//通知前端，上传失败
        }
        return;
    }
}

// 判断该文件是否已经存在于bucket   
// bucket   file:上传文件
// 返回值  'same name':同名不同文件 'not exist':不存在该文件  'true':该文件已存在bucket中
async function existInBucket({ bucket, file }) {
    if (s3 === null) {
        return console.log("未创建s3客户端，请先调用init事件");
    }
    const obj = await getObject({ bucket: bucket, key: file.name });
    if (obj != 'err') {
        //判断文件大小是否一样
        if (obj.ContentLength !== file.size) {
            return 'same name';
        } else {
            //获取文件的文件体 计算某个分片的md5
            const fileBody = obj.Body;
            //ReadableStream  转换成  arrayBuffer 
            const reader = await fileBody.getReader();
            let temp = await new Promise((resolve) => {
                let bodyBuffer = [];
                reader.read().then(function processText({ done, value }) {
                    if (done) {
                        //此时value的值为undefined
                        resolve(bodyBuffer);
                        return;
                    }
                    if ((bodyBuffer.length + value.byteLength) > chunkSize) {
                        bodyBuffer = [...bodyBuffer, ...value];
                        resolve(bodyBuffer);
                        reader.cancel();
                        return;
                    } else {
                        bodyBuffer = [...bodyBuffer, ...value];
                    }
                    return reader.read().then(processText);
                });
            });
            if (temp.length > chunkSize) {
                temp = temp.splice(0, chunkSize);
            }
            //转换成Uint8Array
            temp = new Uint8Array(temp);
            // 将传入文件的fileReader 转成  arrayBuffer
            let fileArrayBuff = null;
            fileArrayBuff = await new Promise((resolve) => {
                let fileReader = new FileReader();
                fileReader.readAsArrayBuffer(file);
                fileReader.onload = (e) => {
                    resolve(e.target.result);
                };
            });
            if (fileArrayBuff.byteLength > chunkSize) {
                fileArrayBuff = fileArrayBuff.slice(0, chunkSize);
            }
            let bodyMD5 = await getMD5({ arrayBuffer: temp.buffer });
            let fileMD5 = await getMD5({ arrayBuffer: fileArrayBuff });
            if (bodyMD5 === fileMD5) {
                //证明是同一个文件 秒传
                return 'true';
            } else {
                return 'same name';
            }
        }
    } else {
        return 'not exist';
    }
}

//判断该文件是否正在上传
// bucket:bucket   file:上传文件 
//返回值 'not exist upload':不存在上传事件  'same name':同名不同文件 
async function existUpload({ bucket, file }) {
    //判断该文件是否有上传事件
    const listUploads = await listMultipartUploadsCommand({ bucket: bucket, name: file.name });
    if (listUploads != 'err') {
        if (listUploads.Uploads != undefined && listUploads.Uploads.length > 0) {
            //存在上传事件 获取上传的第一个分片的eTag，计算传入文件md5，相比较是否相同
            const uploads = listUploads.Uploads;
            for (const one in uploads) {//可能存在多个连接
                let uploadOne = uploads[one];
                const uploadId = uploadOne.UploadId;//UploadId
                const key = uploadOne.Key;//key
                //查询该文件已上传分片
                const listParts = await listPartsCommand({ bucket: bucket, key: key, uploadId: uploadId });
                if (listParts != 'err') {
                    if (listParts.Parts != undefined && listParts.Parts.length != 0) {
                        //存在分片
                        let etag = listParts.Parts[0].ETag;
                        //计算文件的第一个分片的md5
                        let fileSlice = null;
                        if (file.size > chunkSize) {
                            fileSlice = file.slice(0, chunkSize);
                        } else {
                            fileSlice = file;
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
                message: 'same name'
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
    let md5 = await new Promise((resolve) => {
        var spark = new SparkMD5.ArrayBuffer();
        spark.append(arrayBuffer);
        const m = spark.end();
        resolve(m);
    });
    return md5;
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
            const data = await s3.send(new CreateMultipartUploadCommand(params));
            return data;
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
            const data = await s3.send(new UploadPartCommand(params));
            return data;
        } catch (err) {
            console.log('上传分片第 ' + num + ' 片错误信息', err.message)
            return 'err';
        }
    }
    return res();
}
//将分片合并
async function completeMultipartUpload({ bucket, key, parts, uploadId }) {
    if (s3 === null) {
        return console.log("未创建s3客户端，请先调用init事件");
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
            const data = await s3.send(new CompleteMultipartUploadCommand(params));
            return data
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
            const data = await s3.send(new ListPartsCommand(params));
            return data;
        } catch (err) {
            console.log("查询该文件已上传分片失败: " + err.message);
            return 'err';
        }
    }
    return res();
}
//查询该文件是否存在上传事件
async function listMultipartUploadsCommand({ bucket, name }) {
    if (s3 === null) {
        return console.log("未创建s3客户端，请先调用init事件");
    }
    const params = {
        Bucket: bucket,
        Delimiter: '',
        MaxUploads: 1000,
        Prefix: name
    };
    const res = async () => {
        try {
            const data = await s3.send(new ListMultipartUploadsCommand(params));
            return data;
        } catch (err) {
            console.log("查询 " + name + " 文件是否存在上传事件失败: " + err.message);
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
            const data = await s3.send(new AbortMultipartUploadCommand(params));
            return data
        } catch (err) {
            console.log("取消 " + key + " 文件连接失败: " + err.message);
            return 'err';
        }
    }
    return res();
}
//获取文件
async function getObject({ bucket, key }) {
    if (s3 === null) {
        return console.log("未创建s3客户端，请先调用init事件");
    }
    const params = {
        Bucket: bucket,
        Key: key,
    };
    const res = async () => {
        try {
            const data = await s3.send(new GetObjectCommand(params));
            return data;
        } catch (err) {
            console.log('获取 ' + key + ' 文件失败：', err.message);
            return 'err';
        }
    }
    return res();
}

