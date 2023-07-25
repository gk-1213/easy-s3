<template>
    <div class="about">
        <div style="display: flex;justify-content: center;align-items: center;">
            <el-form label-position="left" label-width="120px" :model="s3Clent" style="width:500px">
                <el-form-item label="endpoint">
                    <el-input v-model="s3Clent.endpoint"></el-input>
                </el-form-item>
                <el-form-item label="region">
                    <el-input v-model="s3Clent.region"></el-input>
                </el-form-item>
                <el-form-item label="signatureVersion">
                    <el-input v-model="s3Clent.signatureVersion"></el-input>
                </el-form-item>
                <el-form-item label="accessKeyId">
                    <el-input v-model="s3Clent.credentials.accessKeyId"></el-input>
                </el-form-item>
                <el-form-item label="secretAccessKey">
                    <el-input v-model="s3Clent.credentials.secretAccessKey"></el-input>
                </el-form-item>
            </el-form>
        </div>
        <input multiple v-show="false" ref="fileRef" type="file" @change="inputFile">
        <el-button type="primary" @click="upload()">点击上传文件</el-button>

        <div v-for="f in fileList" :key="f.key">
            <div style="margin-top:50px;display: flex;align-items: center;justify-content: center;" v-if="f.show">
                <div style="margin-right:20px;font-size:15px;font-weight:60">
                    {{ f.key }}
                </div>
                <el-progress :percentage="f.percentage" style="width:500px"></el-progress>
                <div style="margin-left:20px">
                    <span v-if="f.status == 'err'" style="color:#F56C6C">上传错误</span>
                    <span v-else-if="f.status == 'same key'" style="color:#F56C6C">同名文件</span>
                    <span v-else-if="f.status == 'success'" style="color:#67C23A">上传成功</span>
                    <span v-else-if="f.status == 'suspend'" style="color:#409EFF">已暂停</span>
                </div>
                <div style="margin-left:20px">
                    <!-- 暂停按钮 -->
                    <el-button type="primary" icon="el-icon-video-pause" circle v-if="f.status === 'wait'"
                        @click="suspendButton(f)"></el-button>
                    <!-- 继续按钮 -->
                    <el-button type="primary" icon="el-icon-video-play" circle v-if="f.status === 'suspend'"
                        @click="continuedButton(f)"></el-button>
                    <!-- 取消按钮 -->
                    <el-button type="danger" icon="el-icon-close" circle v-if="f.status === 'suspend' || f.status === 'err'"
                        @click="cancelButton(f)"></el-button>
                    <!-- 重试按钮 -->
                    <el-button type="primary" icon="el-icon-refresh-right" circle v-if="f.status === 'err'"
                        @click="continuedButton(f)"></el-button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { init, cancel, fileChange, getWorker } from '../assets/js/s3.js'
export default {
    data() {
        return {
            fileList: [],//存储上传文件列表
            s3Clent: {
                endpoint: "http://minio.3wok.top",
                region: 'us-east-1',
                s3ForcePathStyle: true,
                signatureVersion: 'v4',
                forcePathStyle: true,

                credentials: {
                    accessKeyId: '0r7OhuS86vkBc7it',
                    secretAccessKey: '14DCVAwMX4FYhQno8OLRRyVKAbJkPfcY'
                },
            }//s3配置文件
        }
    },
    methods: {
        async continuedButton(file) {
            file.needSuspend = false;
            file.status = 'wait';
            const isInQueue = getWorker(file.key);
            console.log("isInQueue", isInQueue)
            if (isInQueue === false) {
                //如果任务队列中没有这个文件上传任务，那么就加入到任务队列中
                let inputFile = {
                    key: file.name,//文件对象名(一般为文件的名称，也可根据需求自定)
                    percentage: file.percentage,
                    status: file.status,
                    show: file.show,
                    file: file.file,
                    needSuspend: file.needSuspend,
                    sharding: file.sharding,//分片数组
                    shardSize: file.shardSize//每个分片的大小
                }
                fileChange({ fileList: [inputFile], bucket: 'test', changeStatus: this.changeStatus, getSuspend: this.getSuspend, changeSharding: this.changeSharding });
            }

        },
        async cancelButton(f) {
            let result = await cancel({ bucket: 'test', f: f });
            if (result == true) {
                this.fileList = this.fileList.filter(e => {
                    return e.key !== f.key;
                });
            }
        },
        upload() {
            this.$refs.fileRef.dispatchEvent(new MouseEvent('click'));
        },
        inputFile(event) {
            let files = event.target.files;
            let addFile = [];
            for (let i = 0; i < files.length; i++) {
                this.fileList.push({
                    key: files[i].name,//文件对象名(一般为文件的名称，也可根据需求自定)
                    percentage: 0,
                    status: 'wait',
                    show: true,
                    file: files[i],
                    needSuspend: false,
                    sharding: [],//分片数组
                    shardSize: 32 * 1024 * 1024//每个分片的大小
                });
                addFile.push({
                    key: files[i].name,//文件对象名(一般为文件的名称，也可根据需求自定)
                    percentage: 0,
                    status: 'wait',
                    show: true,
                    file: files[i],
                    needSuspend: false,
                    sharding: [],//分片数组
                    shardSize: 32 * 1024 * 1024//每个分片的大小
                });
            }
            fileChange({ fileList: addFile, bucket: 'test', changeStatus: this.changeStatus, getSuspend: this.getSuspend, changeSharding: this.changeSharding })
        },
        //暂停
        suspendButton(file) {
            file.needSuspend = true;
            file.status = 'suspend';
        },
        //修改状态
        changeStatus(key, val) {
            console.log('val')
            for (let i = 0; i < this.fileList.length; i++) {
                if (this.fileList[i].key == key) {
                    this.fileList[i].status = val;
                    if (val === 'success') {
                        this.fileList[i].percentage = 100;
                    }
                    break;
                }
            }
        },
        //修改分片数组
        changeSharding(key, shard) {
            for (let i = 0; i < this.fileList.length; i++) {
                if (this.fileList[i].key === key) {
                    this.fileList[i].sharding = shard;
                    //改变进度条
                    let size = 0;
                    for (let j = 0; j < shard.length; j++) {
                        size += shard[j].Size;
                    }
                    this.fileList[i].percentage = ((size / this.fileList[i].file.size) * 100).toFixed(1) - 0;
                    return;
                }
            }
        },
        //获取该文件是否需要暂停
        getSuspend(key) {
            let suspend = this.fileList.filter(e => {
                return e.key === key;
            });
            if (suspend.length != 0) {
                return suspend[0].needSuspend;
            }
            return false;
        },

    },
    created() {
        //创建客户端
        init(this.s3Clent);
    }
}
</script>