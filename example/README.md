1、初始化s3客户端以及设置每个文件分片的大小  ，调用init()方法

示例：

```javascript
init({
       endpoint: "http://minio.3wok.top",
       region: 'us-east-1',
       s3ForcePathStyle: true,//非必填 默认true
       signatureVersion: 'v4',
       forcePathStyle: true,//非必填 默认true
       credentials: {
           accessKeyId: '0r7OhuS86vkBc7it',
           secretAccessKey: '14DCVAwMX4FYhQno8OLRRyVKAbJkPfcY'
       },
    fragmentationSize:32,//非必填，默认32 即每个分片的大小为32M 必须大于等于5
});
```

2、上传文件+暂停，调用fileChange方法  

示例：

```javascript
fileChange(//均为必传
    { 
        files: files, //文件列表 [file1,file2,file3,....]
        bucket: 'test', //文件存储的 bucket
     	changePercentage: this.changePercentage, //传入一个可以改变页面文件上传进度的方法
     	changeStatus: this.changeStatus, //传入一个可以改变页面上文件状态的方法（上传成功、上传失败、上传暂停）
     	getSuspend: this.getSuspend ,//传入一个可以返回文件是否暂停的方法
    }
)
//暂停 点击暂停按钮之后，该文件状态改为  需要暂停
suspendButton(file) {
   file.needSuspend = true;
},
//修改进度条
changePercentage(file, val) {
   for (let i = 0; i < this.fileList.length; i++) {
        if (this.fileList[i].file.name == file.name) {
        this.fileList[i].percentage = val;
        break;
    }
   }
},
//修改状态  
//fileChange返回的状态有：
//1、success上传成功  2、err上传失败  3、same name 文件有相同key的上传事件，需要改名后上传 4、suspend 暂停
changeStatus(file, val) {
for (let i = 0; i < this.fileList.length; i++) {
    if (this.fileList[i].file.name == file.name) {
        this.fileList[i].status = val;
        break;
     }
  }
},
//获取该文件是否需要暂停
getSuspend(file) {
  let suspend = this.fileList.filter(e => {
  		return e.file.name === file.name;
  	});
   if (suspend.length != 0) {
       return suspend[0].needSuspend;//返回false，不需要暂停，返回true，需要暂停
   }
   return false;
},
```

3、取消文件上传，调用cancel方法

```javascript
await cancel({ bucket: 'test', file: f.file });//均为必传
//TODO  前端页面需要将页面上的该文件隐藏
```





所有api使用示例

```javascript
<template>
    <div class="about">
        <input multiple v-show="false" ref="fileRef" type="file" @change="inputFile">
        <el-button type="primary" @click="upload()">点击上传文件</el-button>

        <div v-for="f in fileList" :key="f.file.name">
            <div style="margin-top:50px;display: flex;align-items: center;justify-content: center;" v-if="f.show">
                <div style="margin-right:20px;font-size:15px;font-weight:60">
                    {{ f.file.name }}
                </div>
                <el-progress :percentage="f.percentage" style="width:500px"></el-progress>
                <div style="margin-left:20px">
                    <span v-if="f.status == 'err'" style="color:#F56C6C">上传错误</span>
                    <span v-else-if="f.status == 'same name'" style="color:#F56C6C">同名文件</span>
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
import { init, cancel, fileChange } from '../assets/js/s3.js'
export default {
    data() {
        return {
            fileList: [],
        }
    },
    methods: {
        async continuedButton(file) {
            file.needSuspend = false;
            file.status = 'wait';
            fileChange({ files: [file.file], bucket: 'test', changePercentage: this.changePercentage, changeStatus: this.changeStatus, getSuspend: this.getSuspend });
        },
        async cancelButton(f) {
            await cancel({ bucket: 'test', file: f.file });
            this.fileList = this.fileList.filter(e => {
                return e.file.name !== f.file.name;
            });
        },
        upload() {
            this.$refs.fileRef.dispatchEvent(new MouseEvent('click'));
        },
        async inputFile(event) {
            let files = event.target.files;
            for (let i = 0; i < files.length; i++) {
                this.fileList.push({
                    percentage: 0,
                    status: 'wait',
                    show: true,
                    file: files[i],
                    needSuspend: false,
                });
            }
            fileChange({ files: files, bucket: 'test', changePercentage: this.changePercentage, changeStatus: this.changeStatus, getSuspend: this.getSuspend })
        },
        //暂停
        suspendButton(file) {
            file.needSuspend = true;
        },
        //修改进度条
        changePercentage(file, val) {
            for (let i = 0; i < this.fileList.length; i++) {
                if (this.fileList[i].file.name == file.name) {
                    this.fileList[i].percentage = val;
                    break;
                }
            }
        },
        //修改状态
        changeStatus(file, val) {
            for (let i = 0; i < this.fileList.length; i++) {
                if (this.fileList[i].file.name == file.name) {
                    this.fileList[i].status = val;
                    break;
                }
            }
        },
        //获取该文件是否需要暂停
        getSuspend(file) {
            let suspend = this.fileList.filter(e => {
                return e.file.name === file.name;
            });
            if (suspend.length != 0) {
                return suspend[0].needSuspend;
            }
            return false;
        },
    },
    created() {
        //创建客户端
        init({
            endpoint: "http://minio.3wok.top",
            region: 'us-east-1',
            s3ForcePathStyle: true,
            signatureVersion: 'v4',
            forcePathStyle: true,

            credentials: {
                accessKeyId: '0r7OhuS86vkBc7it',
                secretAccessKey: '14DCVAwMX4FYhQno8OLRRyVKAbJkPfcY'
            },
        });
    }
}
</script>
```

