const mocha = require('mocha');
const describe = mocha.describe;
const it = mocha.it;
const expect = require('chai').expect;
const defaults = require('../app/utilities.js');

describe('utilities.js', () => {
    it('should have a default export', () => {
        expect(defaults).to.have.property('cleanPath')
            .that.is.a('function');
        expect(defaults).to.have.property('copyFile')
            .that.is.a('function');
        expect(defaults).to.have.property('createDirectory')
            .that.is.a('function');
        expect(defaults).to.have.property('debug')
            .that.is.a('function');
        expect(defaults).to.have.property('exists')
            .that.is.a('function');
        expect(defaults).to.have.property('folder')
            .that.is.a('function');
        expect(defaults).to.have.property('getFile')
            .that.is.a('function');
        expect(defaults).to.have.property('getFilesInFolder')
            .that.is.a('function');
        expect(defaults).to.have.property('randomString')
            .that.is.a('function');
        expect(defaults).to.have.property('removeDirectory')
            .that.is.a('function');
        expect(defaults).to.have.property('removeFile')
            .that.is.a('function');
        expect(defaults).to.have.property('writeFile')
            .that.is.a('function');
    });
})