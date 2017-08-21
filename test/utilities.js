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
        expect(defaults).to.have.property('formatDate')
            .that.is.a('function');
        expect(defaults).to.have.property('getFile')
            .that.is.a('function');
        expect(defaults).to.have.property('getFilesInFolder')
            .that.is.a('function');
        expect(defaults).to.have.property('isDate')
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
    describe('formatDate', () => {
        const formatDate = defaults.formatDate
        it('should return date formatted as YYYY-MM-DDTHH-MM-SS', () => {
            const date = new Date(1503341243862)
            expect(formatDate(date)).to.equal('2017-07-21T18-47-23')
        });
        it('should return false when input is not a date', () => {
            expect(formatDate(undefined)).to.equal(false)
        });
    });
    describe('isDate', () => {
        const isDate = defaults.isDate;
        it('should return true when Date', () => {
            expect(isDate(new Date())).to.equal(true);
        })
        it('should return false when invalid Date', () => {
            expect(isDate(new Date('a'))).to.equal(false);
        })
        it('should return false when undefined', () => {
            expect(isDate(undefined)).to.equal(false);
        })
        it('should return false when null', () => {
            expect(isDate(null)).to.equal(false);
        })
        it('should return false when object', () => {
            expect(isDate({})).to.equal(false);
        })
        it('should return false when array', () => {
            expect(isDate([])).to.equal(false);
        })
        it('should return false when boolean', () => {
            expect(isDate(true)).to.equal(false);
        })
        it('should return false when number', () => {
            expect(isDate(1)).to.equal(false);
        })
        it('should return false when string', () => {
            expect(isDate('')).to.equal(false);
        })
        it('should return false when function', () => {
            expect(isDate(function () {})).to.equal(false);
        })
    });
})